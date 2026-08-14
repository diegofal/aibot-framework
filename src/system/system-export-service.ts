/**
 * Whole-system export: everything needed to stand up an equivalent instance on
 * another machine, and nothing that would be wrong (or dangerous) to carry
 * across.
 *
 * What is deliberately NOT in a bundle, and why:
 *
 * - **Secret values.** Every credential becomes a `${VAR}` placeholder and is
 *   listed in `REQUIRED_ENV.txt`. See `config-sanitizer.ts`.
 * - **`data/memory.db`** (and its `-wal`/`-shm` siblings). The vector index is
 *   derived from soul files and is re-embedded on first run. Shipping it is
 *   worse than omitting it: embeddings are model-specific, so a stale index
 *   silently degrades RAG on a target running a different embedding model, and
 *   the failure looks like "the bot forgot things" rather than a bad restore.
 * - **`data/logs`, `data/screenshots`, `data/intel`.** Output and caches. Large,
 *   regenerable, and frequently the place where a stray credential ends up.
 * - **Machine-specific settings** — Ollama base URL, Claude binary path, web
 *   host/port, absolute soul/work/data directories. Carrying these makes a
 *   restored instance point at the old host.
 * - **`.env`.** By definition the file the operator must recreate by hand.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { BotExportService } from '../bot/bot-export-service';
import { EXPORT_VERSION } from '../bot/bot-export-service';
import type { Config } from '../config';
import { botsPathFromConfigPath } from '../config';
import type { Logger } from '../logger';
import { collectDirEntries, sha256 } from './archive-fs';
import {
  type SanitizeReport,
  mergeReports,
  redactJsonDocument,
  renderRequiredEnv,
  sanitizeBotRoster,
  sanitizeSystemConfig,
  scrubEmbeddedSecrets,
} from './config-sanitizer';
import { type TarEntry, packTarGz } from './tar-archive';
import {
  ALL_SECTIONS,
  type AgentInventoryEntry,
  type ExclusionNote,
  SYSTEM_EXPORT_KIND,
  SYSTEM_EXPORT_VERSION,
  type SystemManifest,
  type SystemSection,
} from './types';

/** Directory names never worth carrying, wherever they appear under `data/`. */
const EXCLUDED_DATA_DIRS = new Set(['logs', 'screenshots', 'intel', 'node_modules', '.git']);

/** Files never worth carrying: the vector index and its SQLite sidecars. */
const EXCLUDED_FILE_PATTERN = /(^|\/)memory\.db(-wal|-shm)?$/;

/** Extensions treated as text and therefore swept for embedded credentials. */
const TEXT_EXTENSIONS = new Set([
  '.json',
  '.jsonl',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.js',
  '.ts',
  '.mjs',
  '.cjs',
  '.csv',
  '.log',
  '.html',
  '.xml',
  '.env',
]);

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface SystemExportOptions {
  sections?: SystemSection[];
  /** Restrict the `agents` section to these bot ids. */
  agentIds?: string[];
  productions?: boolean;
  conversations?: boolean;
  karma?: boolean;
  sessions?: boolean;
}

export interface SystemExportResult {
  buffer: Buffer;
  manifest: SystemManifest;
}

export interface SystemExportDeps {
  config: Config;
  configPath: string;
  logger: Logger;
  /** Root the config's relative paths resolve against. Defaults to the cwd. */
  rootDir?: string;
  /** Injected for tests and to reuse a service already wired to live memory. */
  botExportService?: BotExportService;
  frameworkVersion?: string;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

function looksBinary(data: Buffer): boolean {
  return data.subarray(0, 8000).includes(0);
}

export class SystemExportService {
  private readonly rootDir: string;
  private readonly botExport: BotExportService;

  constructor(private deps: SystemExportDeps) {
    this.rootDir = deps.rootDir ?? process.cwd();
    this.botExport =
      deps.botExportService ?? new BotExportService(deps.config, deps.configPath, deps.logger);
  }

  private resolvePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.rootDir, path);
  }

  private frameworkVersion(): string {
    if (this.deps.frameworkVersion) return this.deps.frameworkVersion;
    try {
      const pkg = JSON.parse(readFileSync(join(this.rootDir, 'package.json'), 'utf-8'));
      return typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async export(opts: SystemExportOptions = {}): Promise<SystemExportResult> {
    const sections = opts.sections?.length ? opts.sections : [...ALL_SECTIONS];
    const exportedAt = new Date().toISOString();
    const entries: TarEntry[] = [];
    const excluded: ExclusionNote[] = [];
    const scrubbedFiles: string[] = [];
    const reports: SanitizeReport[] = [];
    const agents: AgentInventoryEntry[] = [];

    if (sections.includes('config')) {
      reports.push(this.addGlobalConfig(entries));
    }
    if (sections.includes('agents')) {
      reports.push(await this.addAgents(entries, agents, opts));
    }
    if (sections.includes('data')) {
      this.addDataDirectories(entries, excluded);
    }
    if (sections.includes('tenants')) {
      this.addTenantTree(entries, excluded);
    }

    // The credential sweep runs over the assembled bundle rather than at each
    // collection site, so a section added later cannot bypass it.
    for (const entry of entries) {
      if (!entry.data || looksBinary(entry.data)) continue;
      if (!TEXT_EXTENSIONS.has(extensionOf(entry.path)) && extensionOf(entry.path) !== '') continue;
      const { text, hits } = scrubEmbeddedSecrets(entry.data.toString('utf-8'));
      if (hits.length > 0) {
        entry.data = Buffer.from(text, 'utf-8');
        scrubbedFiles.push(entry.path);
        this.deps.logger.warn(
          { path: entry.path, kinds: [...new Set(hits)] },
          'System export: redacted embedded credential from bundled file'
        );
      }
    }

    const report = mergeReports(...reports);
    excluded.push(
      {
        path: 'data/memory.db',
        reason:
          'Vector index — regenerated from soul files on first run; embeddings are model-specific',
      },
      { path: 'data/logs', reason: 'Runtime logs — not part of instance state' },
      { path: 'data/screenshots', reason: 'Browser tool output — regenerable' },
      { path: 'data/intel', reason: 'Intel gatherer cache — regenerable' },
      { path: '.env', reason: 'Secrets — recreate from REQUIRED_ENV.txt on the target' },
      {
        path: 'productions/',
        reason: 'Included per agent by default; omit with productions=false / --no-productions',
      }
    );

    const checksums: Record<string, string> = {};
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.data) continue;
      checksums[entry.path] = sha256(entry.data);
      files++;
      bytes += entry.data.length;
    }

    const requiredEnvText = renderRequiredEnv(report, exportedAt);
    entries.push({ path: 'REQUIRED_ENV.txt', data: Buffer.from(requiredEnvText, 'utf-8') });
    checksums['REQUIRED_ENV.txt'] = sha256(requiredEnvText);
    files++;
    bytes += Buffer.byteLength(requiredEnvText);

    const manifest: SystemManifest = {
      kind: SYSTEM_EXPORT_KIND,
      version: SYSTEM_EXPORT_VERSION,
      agentExportVersion: EXPORT_VERSION,
      frameworkVersion: this.frameworkVersion(),
      exportedAt,
      source: {
        hostname: hostname(),
        platform: process.platform,
        arch: process.arch,
        runtime: `bun ${typeof Bun === 'undefined' ? 'unknown' : Bun.version}`,
      },
      sections,
      inventory: { agents, files, bytes, excluded },
      security: {
        redacted: report.redacted,
        dropped: report.dropped,
        requiredEnv: report.required,
        scrubbedFiles,
      },
      checksums,
    };

    entries.push({
      path: 'manifest.json',
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf-8'),
    });

    const buffer = packTarGz(entries);
    this.deps.logger.info(
      {
        sections,
        agents: agents.length,
        files,
        bytes,
        size: buffer.length,
        redacted: report.redacted.length,
        scrubbed: scrubbedFiles.length,
      },
      'System export created'
    );

    return { buffer, manifest };
  }

  /**
   * Read `config.json` from disk, never from `this.deps.config`.
   *
   * `loadConfig()` expands `${VAR}` before validation, so the in-memory config
   * holds resolved secrets. Sanitizing that object would write real tokens into
   * the bundle while looking, in code, exactly like this function.
   */
  private addGlobalConfig(entries: TarEntry[]): SanitizeReport {
    const raw = JSON.parse(readFileSync(this.deps.configPath, 'utf-8'));
    const { config, report } = sanitizeSystemConfig(raw);
    entries.push({
      path: 'config/config.json',
      data: Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf-8'),
    });
    return report;
  }

  private async addAgents(
    entries: TarEntry[],
    inventory: AgentInventoryEntry[],
    opts: SystemExportOptions
  ): Promise<SanitizeReport> {
    const botsPath = botsPathFromConfigPath(this.deps.configPath);
    const rawBots = existsSync(botsPath)
      ? JSON.parse(readFileSync(botsPath, 'utf-8'))
      : this.deps.config.bots;

    const selected: unknown[] = opts.agentIds?.length
      ? (rawBots as Array<Record<string, unknown>>).filter((bot) =>
          opts.agentIds?.includes(String(bot.id))
        )
      : rawBots;

    const { bots, report } = sanitizeBotRoster(selected);
    entries.push({
      path: 'config/bots.json',
      data: Buffer.from(`${JSON.stringify(bots, null, 2)}\n`, 'utf-8'),
    });

    for (const bot of bots) {
      const botId = String(bot.id);
      if (!this.deps.config.bots.some((candidate) => candidate.id === botId)) {
        this.deps.logger.warn(
          { botId },
          'System export: bot present in bots.json but not in the loaded config, skipping payload'
        );
        continue;
      }

      const botEntries = await this.botExport.collectBotEntries(botId, {
        productions: opts.productions,
        conversations: opts.conversations,
        karma: opts.karma,
        sessions: opts.sessions,
      });

      let bytes = 0;
      let files = 0;
      for (const entry of botEntries) {
        entries.push({ ...entry, path: `agents/${botId}/${entry.path}` });
        if (entry.data) {
          bytes += entry.data.length;
          files++;
        }
      }

      inventory.push({
        id: botId,
        name: String(bot.name ?? botId),
        files,
        bytes,
        includes: {
          productions: opts.productions !== false,
          conversations: opts.conversations !== false,
          karma: opts.karma !== false,
          sessions: opts.sessions !== false,
        },
      });
    }

    return report;
  }

  private addDataDirectories(entries: TarEntry[], excluded: ExclusionNote[]): void {
    const dataTargets: Array<{ source: string; archivePath: string }> = [
      { source: this.deps.config.cron?.storePath ?? './data/cron', archivePath: 'data/cron' },
      {
        source: this.deps.config.session?.dataDir ?? './data/sessions',
        archivePath: 'data/sessions',
      },
      {
        source: this.deps.config.dynamicTools?.storePath ?? './data/tools',
        archivePath: 'data/tools',
      },
      {
        source: this.deps.config.agentProposals?.storePath ?? './data/agent-proposals',
        archivePath: 'data/agent-proposals',
      },
      { source: this.deps.config.karma?.baseDir ?? './data/karma', archivePath: 'data/karma' },
    ];

    for (const { source, archivePath } of dataTargets) {
      const hostPath = this.resolvePath(source);
      if (!existsSync(hostPath)) continue;
      entries.push(
        ...collectDirEntries(hostPath, archivePath, {
          filter: (relativePath, isDirectory) =>
            isDirectory
              ? !EXCLUDED_DATA_DIRS.has(relativePath.split('/').pop() ?? '')
              : !EXCLUDED_FILE_PATTERN.test(relativePath),
          maxFileBytes: DEFAULT_MAX_FILE_BYTES,
          onSkipped: (relativePath, reason) =>
            excluded.push({ path: `${archivePath}/${relativePath}`, reason }),
        })
      );
    }

    const contactsFile = this.deps.config.phoneCall?.contactsFile ?? './data/contacts.json';
    const contactsPath = this.resolvePath(contactsFile);
    if (existsSync(contactsPath) && statSync(contactsPath).isFile()) {
      const { text, redacted } = redactJsonDocument(readFileSync(contactsPath, 'utf-8'));
      if (redacted.length > 0) {
        this.deps.logger.info(
          { count: redacted.length },
          'System export: blanked credential fields in contacts file'
        );
      }
      entries.push({ path: 'data/contacts.json', data: Buffer.from(text, 'utf-8') });
    }
  }

  /**
   * The tenant tree doubles as the default soul storage location
   * (`data/tenants/__admin__/bots/<id>/soul`), so per-bot soul directories are
   * excluded here — the `agents` section already carries them, with `.versions/`
   * stripped and core memory attached.
   */
  private addTenantTree(entries: TarEntry[], excluded: ExclusionNote[]): void {
    const dataDir = this.resolvePath(this.deps.config.multiTenant?.dataDir ?? './data/tenants');
    if (!existsSync(dataDir)) return;

    const collected = collectDirEntries(dataDir, 'tenants', {
      filter: (relativePath, isDirectory) => {
        const segments = relativePath.split('/');
        if (segments.includes('soul')) return false;
        if (isDirectory) return !EXCLUDED_DATA_DIRS.has(segments[segments.length - 1] ?? '');
        return !EXCLUDED_FILE_PATTERN.test(relativePath);
      },
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      onSkipped: (relativePath, reason) =>
        excluded.push({ path: `tenants/${relativePath}`, reason }),
    });

    // Tenant records hold API keys, password hashes and Stripe identifiers.
    // They are blanked rather than placeheld: these are data files, never
    // env-expanded, so the operator re-issues credentials on the target.
    for (const entry of collected) {
      const extension = extensionOf(entry.path);
      if (entry.data && (extension === '.json' || extension === '.jsonl')) {
        const { text, redacted } = redactJsonDocument(entry.data.toString('utf-8'));
        if (redacted.length > 0) entry.data = Buffer.from(text, 'utf-8');
      }
    }

    excluded.push({
      path: 'tenants/*/bots/*/soul',
      reason: 'Carried by the agents section instead (deduplicated)',
    });
    entries.push(...collected);
  }
}

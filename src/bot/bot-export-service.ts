import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BotConfig, Config } from '../config';
import { persistBots, resolveAgentConfig } from '../config';
import type { Logger } from '../logger';
import { type CoreMemoryManager, createCoreMemoryManager } from '../memory/core-memory';
import { initializeMemoryDb } from '../memory/schema';
import { collectDirEntries, hasSubtree, subtree, writeArchiveToDisk } from '../system/archive-fs';
import { sanitizeBotRoster } from '../system/config-sanitizer';
import { type TarArchive, type TarEntry, packTarGz, unpackTarGz } from '../system/tar-archive';

export const EXPORT_VERSION = 1;

export interface ExportOptions {
  productions?: boolean;
  conversations?: boolean;
  karma?: boolean;
  sessions?: boolean;
}

export interface ImportOptions {
  newBotId?: string;
  newBotName?: string;
  overwrite?: boolean;
}

export interface ImportResult {
  botId: string;
  botName: string;
  warnings: string[];
  created: boolean;
}

interface ExportManifest {
  version: number;
  botId: string;
  botName: string;
  exportDate: string;
  includes: {
    soul: boolean;
    coreMemory: boolean;
    productions: boolean;
    conversations: boolean;
    karma: boolean;
    sessions: boolean;
  };
}

/** `.versions/` is soul-file history: large, regenerable, and never restored. */
function excludeSoulVersions(relativePath: string): boolean {
  return !relativePath.split('/').includes('.versions');
}

/** Optional extras default on; only an explicit `false` skips them. */
function includeOptional(flag: boolean | undefined): boolean {
  return flag !== false;
}

function escapeRegExpChars(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TRANSCRIPT_CHAT_TYPES = 'private|group|supergroup|channel';

function transcriptFilePattern(botId: string): RegExp {
  return new RegExp(`^bot-${escapeRegExpChars(botId)}-(${TRANSCRIPT_CHAT_TYPES})-.*\\.jsonl$`);
}

/**
 * Import writes soul files to `soul.dir/<id>` (legacy). `resolveAgentConfig`
 * defaults `soulDir` to the tenant tree, which is often empty on production
 * hosts that never set a per-bot override. Prefer a candidate that actually
 * exists so the archive is not an empty `soul/`.
 */
function resolveExportSoulDir(botId: string, botConfig: BotConfig, config: Config): string | null {
  const resolved = resolveAgentConfig(config, botConfig);
  const candidates = [
    botConfig.soulDir,
    join(config.soul?.dir ?? './config/soul', botId),
    resolved.soulDir,
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // Corrupt index: treat as empty so a restore can still merge.
  }
  return {};
}

function sliceByPrefix(
  record: Record<string, unknown>,
  prefix: string
): Record<string, unknown> | null {
  const sliced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith(prefix)) sliced[key] = value;
  }
  return Object.keys(sliced).length > 0 ? sliced : null;
}

function rewritePrefixedKey(key: string, sourcePrefix: string, targetPrefix: string): string {
  if (sourcePrefix === targetPrefix) return key;
  if (!key.startsWith(sourcePrefix)) return key;
  return `${targetPrefix}${key.slice(sourcePrefix.length)}`;
}

function rewriteTranscriptFilename(
  filename: string,
  sourceBotId: string,
  targetBotId: string
): string {
  if (sourceBotId === targetBotId) return filename;
  const prefix = `bot-${sourceBotId}-`;
  if (!filename.startsWith(prefix)) return filename;
  return `bot-${targetBotId}-${filename.slice(prefix.length)}`;
}

export class BotExportService {
  constructor(
    private config: Config,
    private configPath: string,
    private logger: Logger,
    private getCoreMemory?: () => CoreMemoryManager | null,
    private onSoulFilesImported?: () => Promise<void>
  ) {}

  /**
   * Gather one bot's portable state as archive entries.
   *
   * Split out from `exportBot` so the system exporter can nest the exact same
   * entries under `agents/<id>/` instead of reimplementing soul and core-memory
   * collection. The two exporters therefore cannot drift.
   */
  async collectBotEntries(botId: string, opts: ExportOptions = {}): Promise<TarEntry[]> {
    const botConfig = this.config.bots.find((b) => b.id === botId);
    if (!botConfig) throw new Error(`Bot not found: ${botId}`);

    const entries: TarEntry[] = [];

    // The roster sanitizer is the single place that knows which bot fields are
    // credentials, so per-bot and system exports strip the same set.
    const { bots: sanitized } = sanitizeBotRoster([structuredClone(botConfig)]);
    const sanitizedConfig = sanitized[0] as BotConfig;
    entries.push({
      path: 'config.json',
      data: Buffer.from(JSON.stringify(sanitizedConfig, null, 2), 'utf-8'),
    });

    const soulDir = resolveExportSoulDir(botId, botConfig, this.config);
    if (soulDir) {
      entries.push(
        ...collectDirEntries(soulDir, 'soul', { filter: (path) => excludeSoulVersions(path) })
      );
    } else {
      entries.push({ path: 'soul' });
      this.logger.warn({ botId }, 'Export: soul directory missing, exporting empty');
    }

    let coreMemoryExported = false;
    const coreMemory = this.getCoreMemory?.();
    if (coreMemory) {
      try {
        const memoryEntries = await coreMemory.list(undefined, undefined, botId);
        if (memoryEntries.length > 0) {
          const lines = memoryEntries.map((entry) => JSON.stringify(entry));
          entries.push({
            path: 'core_memory.jsonl',
            data: Buffer.from(`${lines.join('\n')}\n`, 'utf-8'),
          });
          coreMemoryExported = true;
        }
      } catch (err) {
        this.logger.warn({ err, botId }, 'Export: failed to dump core memory');
      }
    }

    const includeProductions = includeOptional(opts.productions);
    const includeConversations = includeOptional(opts.conversations);
    const includeKarma = includeOptional(opts.karma);
    const includeSessions = includeOptional(opts.sessions);

    if (includeProductions) {
      const prodDir = botConfig.productions?.dir ?? join(this.config.productions.baseDir, botId);
      if (existsSync(prodDir)) entries.push(...collectDirEntries(prodDir, 'productions'));
    }
    if (includeConversations) {
      const convDir = join(this.config.conversations.baseDir, botId);
      if (existsSync(convDir)) entries.push(...collectDirEntries(convDir, 'conversations'));
    }
    if (includeKarma) {
      const karmaDir = join(this.config.karma.baseDir, botId);
      if (existsSync(karmaDir)) entries.push(...collectDirEntries(karmaDir, 'karma'));
    }
    if (includeSessions) {
      entries.push(...this.collectSessionEntries(botId));
    }

    const manifest: ExportManifest = {
      version: EXPORT_VERSION,
      botId,
      botName: botConfig.name,
      exportDate: new Date().toISOString(),
      includes: {
        soul: true,
        coreMemory: coreMemoryExported,
        productions: includeProductions,
        conversations: includeConversations,
        karma: includeKarma,
        sessions: includeSessions,
      },
    };
    entries.push({
      path: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
    });

    return entries;
  }

  async exportBot(botId: string, opts: ExportOptions = {}): Promise<Buffer> {
    const entries = await this.collectBotEntries(botId, opts);
    const buffer = packTarGz(entries);
    this.logger.info(
      {
        botId,
        size: buffer.length,
        productions: includeOptional(opts.productions),
        sessions: includeOptional(opts.sessions),
      },
      'Bot exported successfully'
    );
    return buffer;
  }

  async importBot(buffer: Buffer, opts: ImportOptions = {}): Promise<ImportResult> {
    return this.restoreBotArchive(unpackTarGz(buffer), opts);
  }

  /**
   * Restore one bot from an already-extracted archive.
   *
   * Takes the extracted form rather than a buffer so the system importer can
   * hand over an `agents/<id>/` subtree of a larger bundle without repacking.
   *
   * `persistRoster: false` lets the caller batch a single `bots.json` write
   * across many bots — writing it per bot would leave a partially-restored
   * roster on disk if a later bot fails.
   */
  async restoreBotArchive(
    archive: TarArchive,
    opts: ImportOptions & { persistRoster?: boolean } = {}
  ): Promise<ImportResult> {
    const warnings: string[] = [];

    const manifestRaw = archive.files.get('manifest.json');
    if (!manifestRaw) throw new Error('Invalid archive: missing manifest.json');

    const manifest: ExportManifest = JSON.parse(manifestRaw.toString('utf-8'));
    if (manifest.version !== EXPORT_VERSION) {
      throw new Error(
        `Unsupported export version: ${manifest.version} (this build reads version ${EXPORT_VERSION})`
      );
    }

    const configRaw = archive.files.get('config.json');
    if (!configRaw) throw new Error('Invalid archive: missing config.json');

    const importedConfig: BotConfig = JSON.parse(configRaw.toString('utf-8'));
    const botId = opts.newBotId ?? importedConfig.id;
    const botName = opts.newBotName ?? importedConfig.name;

    const existing = this.config.bots.find((b) => b.id === botId);
    if (existing && !opts.overwrite) {
      throw new ConflictError(`Bot "${botId}" already exists. Use overwrite=true to replace.`);
    }
    if (existing && opts.overwrite) {
      warnings.push(`Overwriting existing bot "${botId}"`);
    }

    const targetSoulDir = resolve(this.config.soul.dir, botId);
    if (hasSubtree(archive, 'soul')) {
      if (existing && opts.overwrite && existsSync(targetSoulDir)) {
        rmSync(targetSoulDir, { recursive: true, force: true });
      }
      writeArchiveToDisk(subtree(archive, 'soul'), targetSoulDir);

      if (this.onSoulFilesImported) {
        try {
          await this.onSoulFilesImported();
          this.logger.info({ botId }, 'Import: soul files re-indexed');
        } catch (err) {
          this.logger.warn({ err, botId }, 'Import: failed to re-index soul files');
          warnings.push('Soul files copied but search index was not updated — restart to fix');
        }
      }
    } else {
      warnings.push('Archive has no soul directory');
    }

    const coreMemoryRaw = archive.files.get('core_memory.jsonl');
    if (coreMemoryRaw) {
      await this.restoreCoreMemory(coreMemoryRaw.toString('utf-8'), botId, warnings);
    }

    const optionalDirs: Array<[string, string]> = [
      ['productions', join(this.config.productions.baseDir, botId)],
      ['conversations', join(this.config.conversations.baseDir, botId)],
      ['karma', join(this.config.karma.baseDir, botId)],
    ];
    for (const [prefix, target] of optionalDirs) {
      if (!hasSubtree(archive, prefix)) continue;
      if (existing && opts.overwrite && existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
      }
      mkdirSync(target, { recursive: true });
      writeArchiveToDisk(subtree(archive, prefix), target);
    }

    // Sessions live in a shared directory — never wipe the whole tree the way
    // productions/conversations/karma can. Merge this bot's slice only.
    if (hasSubtree(archive, 'sessions')) {
      this.restoreSessions(archive, manifest.botId || importedConfig.id, botId, !!opts.overwrite);
    }

    // Blank token + enabled:false is load-bearing: boot-time auto-start would
    // otherwise have the new instance poll a token the source may still own.
    const newConfig: BotConfig = {
      ...importedConfig,
      id: botId,
      name: botName,
      token: '',
      enabled: false,
    };

    // A carried-over directory override would point at a path we did not
    // restore into — the source machine's layout, or (under `newBotId`) the
    // source bot's own directory. Dropping it makes the framework compute the
    // usual per-bot location, which is where the files actually landed.
    if (newConfig.soulDir) {
      warnings.push(
        `Soul directory override "${newConfig.soulDir}" dropped — soul restored to ${targetSoulDir}`
      );
      newConfig.soulDir = undefined;
    }
    if (newConfig.workDir) {
      warnings.push(`Work directory override "${newConfig.workDir}" dropped — using the default`);
      newConfig.workDir = undefined;
    }

    if (existing && opts.overwrite) {
      const index = this.config.bots.findIndex((b) => b.id === botId);
      newConfig.token = existing.token ?? '';
      this.config.bots[index] = newConfig;
    } else {
      this.config.bots.push(newConfig);
    }
    if (opts.persistRoster !== false) persistBots(this.configPath, this.config.bots);

    this.logger.info({ botId, botName, warnings }, 'Bot imported successfully');

    return { botId, botName, warnings, created: !existing || !opts.overwrite };
  }

  /**
   * Slice the shared session store down to this bot. Transcripts from both the
   * nested `transcripts/<botId>/` layout and the legacy flat directory land
   * under `sessions/transcripts/<filename>` so the archive does not require
   * the per-bot subdirectory.
   */
  private collectSessionEntries(botId: string): TarEntry[] {
    const sessionDir = this.config.session?.dataDir ?? './data/sessions';
    const entries: TarEntry[] = [];

    const sessions = sliceByPrefix(readJsonObject(join(sessionDir, 'sessions.json')), `bot:${botId}:`);
    if (sessions) {
      entries.push({
        path: 'sessions/sessions.json',
        data: Buffer.from(JSON.stringify(sessions, null, 2), 'utf-8'),
      });
    }

    const active = sliceByPrefix(
      readJsonObject(join(sessionDir, 'active-conversations.json')),
      `${botId}:`
    );
    if (active) {
      entries.push({
        path: 'sessions/active-conversations.json',
        data: Buffer.from(JSON.stringify(active, null, 2), 'utf-8'),
      });
    }

    const seen = new Set<string>();
    const nestedDir = join(sessionDir, 'transcripts', botId);
    if (existsSync(nestedDir)) {
      for (const entry of collectDirEntries(nestedDir, 'sessions/transcripts')) {
        const filename = entry.path.split('/').pop();
        if (filename) seen.add(filename);
        entries.push(entry);
      }
    }

    const flatDir = join(sessionDir, 'transcripts');
    if (existsSync(flatDir)) {
      const pattern = transcriptFilePattern(botId);
      let children: string[] = [];
      try {
        children = readdirSync(flatDir);
      } catch {
        children = [];
      }
      for (const child of children) {
        if (seen.has(child) || !pattern.test(child)) continue;
        const hostPath = join(flatDir, child);
        let stats: ReturnType<typeof statSync>;
        try {
          stats = statSync(hostPath);
        } catch {
          continue;
        }
        if (!stats.isFile()) continue;
        seen.add(child);
        entries.push({
          path: `sessions/transcripts/${child}`,
          data: readFileSync(hostPath),
          mtime: stats.mtime,
        });
      }
    }

    return entries;
  }

  private restoreSessions(
    archive: TarArchive,
    sourceBotId: string,
    targetBotId: string,
    overwrite: boolean
  ): void {
    const sessionDir = this.config.session?.dataDir ?? './data/sessions';
    mkdirSync(sessionDir, { recursive: true });

    const sessionsArchive = subtree(archive, 'sessions');
    const sessionPrefix = { source: `bot:${sourceBotId}:`, target: `bot:${targetBotId}:` };
    const activePrefix = { source: `${sourceBotId}:`, target: `${targetBotId}:` };

    this.mergeJsonSlice(
      join(sessionDir, 'sessions.json'),
      sessionsArchive.files.get('sessions.json'),
      sessionPrefix.source,
      sessionPrefix.target,
      overwrite,
      true
    );
    this.mergeJsonSlice(
      join(sessionDir, 'active-conversations.json'),
      sessionsArchive.files.get('active-conversations.json'),
      activePrefix.source,
      activePrefix.target,
      overwrite,
      false
    );

    const transcriptsRoot = join(sessionDir, 'transcripts');
    const targetTranscripts = join(transcriptsRoot, targetBotId);
    if (overwrite) {
      if (existsSync(targetTranscripts)) {
        rmSync(targetTranscripts, { recursive: true, force: true });
      }
      this.deleteLegacyTranscripts(transcriptsRoot, targetBotId);
    }

    const transcriptTree = subtree(sessionsArchive, 'transcripts');
    if (transcriptTree.files.size === 0) return;

    const rewritten: TarArchive = { files: new Map(), dirs: new Set() };
    for (const [path, data] of transcriptTree.files) {
      const filename = path.split('/').pop() ?? path;
      rewritten.files.set(rewriteTranscriptFilename(filename, sourceBotId, targetBotId), data);
    }
    writeArchiveToDisk(rewritten, targetTranscripts);
  }

  private mergeJsonSlice(
    targetPath: string,
    archiveData: Buffer | undefined,
    sourcePrefix: string,
    targetPrefix: string,
    overwrite: boolean,
    rewriteInnerKey: boolean
  ): void {
    const current = readJsonObject(targetPath);
    if (overwrite) {
      for (const key of Object.keys(current)) {
        if (key.startsWith(targetPrefix)) delete current[key];
      }
    }
    if (archiveData) {
      let incoming: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(archiveData.toString('utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          incoming = parsed as Record<string, unknown>;
        }
      } catch {
        incoming = {};
      }
      for (const [key, value] of Object.entries(incoming)) {
        if (!key.startsWith(sourcePrefix)) continue;
        const nextKey = rewritePrefixedKey(key, sourcePrefix, targetPrefix);
        let nextValue = value;
        if (
          rewriteInnerKey &&
          nextValue &&
          typeof nextValue === 'object' &&
          !Array.isArray(nextValue) &&
          'key' in nextValue &&
          typeof (nextValue as { key: unknown }).key === 'string'
        ) {
          nextValue = {
            ...(nextValue as Record<string, unknown>),
            key: rewritePrefixedKey(
              (nextValue as { key: string }).key,
              sourcePrefix,
              targetPrefix
            ),
          };
        }
        current[nextKey] = nextValue;
      }
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${JSON.stringify(current, null, 2)}\n`, 'utf-8');
  }

  private deleteLegacyTranscripts(transcriptsRoot: string, botId: string): void {
    if (!existsSync(transcriptsRoot)) return;
    const pattern = transcriptFilePattern(botId);
    let children: string[] = [];
    try {
      children = readdirSync(transcriptsRoot);
    } catch {
      return;
    }
    for (const child of children) {
      if (!pattern.test(child)) continue;
      const hostPath = join(transcriptsRoot, child);
      try {
        if (statSync(hostPath).isFile()) unlinkSync(hostPath);
      } catch {
        // Best-effort cleanup; merge still proceeds.
      }
    }
  }

  private async restoreCoreMemory(jsonl: string, botId: string, warnings: string[]): Promise<void> {
    let coreMemory = this.getCoreMemory?.();
    let fallbackDb: ReturnType<typeof initializeMemoryDb> | null = null;
    const dbPath = this.config.soul?.search?.dbPath ?? './data/memory.db';

    if (!coreMemory) {
      try {
        fallbackDb = initializeMemoryDb(dbPath, this.logger);
        coreMemory = createCoreMemoryManager(fallbackDb, this.logger);
        this.logger.info(
          { dbPath },
          'Import: using standalone CoreMemoryManager (no Ollama required)'
        );
      } catch (err) {
        this.logger.warn({ err, dbPath }, 'Import: failed to open memory database for fallback');
        warnings.push(`Core memory data found but could not open database: ${err}`);
      }
    }

    if (coreMemory) {
      let imported = 0;
      for (const line of jsonl.trim().split('\n')) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          await coreMemory.set(entry.category, entry.key, entry.value, entry.importance, botId);
          imported++;
        } catch (err) {
          this.logger.warn(
            { err, line: line.slice(0, 100) },
            'Import: failed to import core memory entry'
          );
        }
      }
      if (imported > 0)
        this.logger.info({ botId, imported }, 'Import: core memory entries restored');
    }

    // Close is best-effort on purpose. `close(true)` throws `database is locked`
    // on Windows (measured on bun 1.3.9) and that exception used to propagate
    // out of restoreBotArchive, failing the whole import *after* every entry had
    // already been written. Losing an import over a file handle is the wrong
    // trade. Note the handle is not actually released until process exit on
    // Windows either way — see tests/helpers/temp-dir.ts.
    try {
      fallbackDb?.close();
    } catch (err) {
      this.logger.warn({ err, dbPath }, 'Import: failed to close fallback memory database');
    }
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

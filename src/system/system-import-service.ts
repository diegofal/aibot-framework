/**
 * Whole-system import.
 *
 * Safety model, in the order the checks run:
 *
 * 1. The bundle must declare itself a system export of a version this build
 *    understands. A per-bot archive fed here (or vice versa) is rejected by
 *    name rather than by a confusing downstream parse error.
 * 2. Every file is checksummed against the manifest before anything is written.
 * 3. No bot may be running. The per-bot route already refuses to overwrite a
 *    running bot; a system import touches the whole roster, so it refuses if
 *    *anything* is running.
 * 4. Collisions are computed for the entire restore **before** the first write.
 *    Without `overwrite` the import fails with the full list, so the target is
 *    never left half-merged — a partially restored data directory is harder to
 *    diagnose than a refusal.
 * 5. Bots land with `enabled: false` and an empty token, so nothing starts
 *    polling Telegram behind the operator's back.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BotExportService, ConflictError } from '../bot/bot-export-service';
import type { BotConfig, Config } from '../config';
import { botsPathFromConfigPath, persistBots } from '../config';
import type { Logger } from '../logger';
import type { CoreMemoryManager } from '../memory/core-memory';
import { hasSubtree, sha256, subtree, subtreeChildren, writeArchiveToDisk } from './archive-fs';
import { PATH_DEFAULTS, buildEffectiveConfig, pickString, readRawConfig } from './effective-config';
import { type TarArchive, unpackTarGz } from './tar-archive';
import {
  SYSTEM_EXPORT_KIND,
  SYSTEM_EXPORT_VERSION,
  type SystemManifest,
  type SystemSection,
} from './types';

export interface SystemImportOptions {
  sections?: SystemSection[];
  /** Restrict the `agents` section to these bot ids. */
  agentIds?: string[];
  /** Required to replace anything that already exists on the target. */
  overwrite?: boolean;
  /** Report the plan without touching the filesystem. */
  dryRun?: boolean;
}

export interface ImportedAgent {
  botId: string;
  botName: string;
  created: boolean;
  warnings: string[];
}

export interface SystemImportResult {
  dryRun: boolean;
  sections: SystemSection[];
  agents: ImportedAgent[];
  filesWritten: number;
  collisions: string[];
  warnings: string[];
  /** Variables from `REQUIRED_ENV.txt` that are not set on this machine. */
  missingEnv: string[];
  manifest: SystemManifest;
}

export interface SystemImportDeps {
  /** Instance root the restored relative paths resolve against. */
  targetRoot: string;
  configPath: string;
  logger: Logger;
  /**
   * Live config when importing into a running instance. Omitted for CLI
   * disaster recovery, where the target may have no loadable config at all.
   */
  config?: Config | null;
  isAnyBotRunning?: () => string[];
  getCoreMemory?: () => CoreMemoryManager | null;
  onSoulFilesImported?: () => Promise<void>;
}

export class VersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionMismatchError';
  }
}

export class SystemImportService {
  private readonly targetRoot: string;

  constructor(private deps: SystemImportDeps) {
    this.targetRoot = deps.targetRoot;
  }

  private resolvePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.targetRoot, path);
  }

  /**
   * Build the `Config` slice the restore path needs.
   *
   * Deliberately avoids `loadConfig()`: a freshly restored `config.json` is
   * full of `${VAR}` placeholders, so Zod validation would fail on the very
   * machine where the operator has not set the variables yet — which is every
   * disaster-recovery scenario.
   */
  private effectiveConfig(bots: BotConfig[]): Config {
    if (this.deps.config) return { ...this.deps.config, bots } as Config;
    return buildEffectiveConfig(readRawConfig(this.deps.configPath), bots, this.targetRoot);
  }

  private targetDataPaths(): Array<{ archivePath: string; hostPath: string }> {
    const raw = readRawConfig(this.deps.configPath);
    const live = this.deps.config as unknown;

    const resolveFrom = (path: string[], fallback: string): string =>
      this.resolvePath(pickString(live, path, pickString(raw, path, fallback)));

    return [
      {
        archivePath: 'data/cron',
        hostPath: resolveFrom(['cron', 'storePath'], PATH_DEFAULTS.cron),
      },
      {
        archivePath: 'data/sessions',
        hostPath: resolveFrom(['session', 'dataDir'], PATH_DEFAULTS.sessions),
      },
      {
        archivePath: 'data/tools',
        hostPath: resolveFrom(['dynamicTools', 'storePath'], PATH_DEFAULTS.tools),
      },
      {
        archivePath: 'data/agent-proposals',
        hostPath: resolveFrom(['agentProposals', 'storePath'], PATH_DEFAULTS.proposals),
      },
      {
        archivePath: 'data/karma',
        hostPath: resolveFrom(['karma', 'baseDir'], PATH_DEFAULTS.karma),
      },
    ];
  }

  private validateManifest(archive: TarArchive): SystemManifest {
    const raw = archive.files.get('manifest.json');
    if (!raw) {
      throw new Error(
        'Invalid bundle: missing manifest.json. Is this a system export? Per-agent archives go to POST /api/agents/import.'
      );
    }

    let manifest: SystemManifest;
    try {
      manifest = JSON.parse(raw.toString('utf-8'));
    } catch (err) {
      throw new Error(`Invalid bundle: manifest.json is not valid JSON (${err})`);
    }

    if (manifest.kind !== SYSTEM_EXPORT_KIND) {
      throw new VersionMismatchError(
        `Not a system export bundle (kind="${manifest.kind ?? 'missing'}"). A single-agent archive must be imported with the agent importer.`
      );
    }
    if (manifest.version !== SYSTEM_EXPORT_VERSION) {
      throw new VersionMismatchError(
        `Bundle schema version ${manifest.version} is not supported by this build (expected ${SYSTEM_EXPORT_VERSION}). Import it with a framework build of the same major version, or re-export from the source instance.`
      );
    }
    return manifest;
  }

  private verifyChecksums(archive: TarArchive, manifest: SystemManifest): string[] {
    const warnings: string[] = [];
    const checksums = manifest.checksums ?? {};

    for (const [path, expected] of Object.entries(checksums)) {
      const data = archive.files.get(path);
      if (!data) throw new Error(`Corrupt bundle: manifest lists "${path}" but it is missing`);
      const actual = sha256(data);
      if (actual !== expected) {
        throw new Error(`Corrupt bundle: checksum mismatch for "${path}"`);
      }
    }

    for (const path of archive.files.keys()) {
      if (path === 'manifest.json') continue;
      if (!(path in checksums)) warnings.push(`File not listed in manifest checksums: ${path}`);
    }
    return warnings;
  }

  async import(buffer: Buffer, opts: SystemImportOptions = {}): Promise<SystemImportResult> {
    const archive = unpackTarGz(buffer);
    const manifest = this.validateManifest(archive);
    const warnings = this.verifyChecksums(archive, manifest);

    const requested = opts.sections?.length ? opts.sections : manifest.sections;
    const sections = requested.filter((section) => {
      if (manifest.sections.includes(section)) return true;
      warnings.push(`Section "${section}" was requested but is not present in the bundle`);
      return false;
    });
    if (sections.length === 0) {
      throw new Error(
        `Nothing to restore. Bundle contains: ${manifest.sections.join(', ') || '(nothing)'}`
      );
    }

    const running = this.deps.isAnyBotRunning?.() ?? [];
    if (running.length > 0) {
      throw new Error(
        `Stop all running agents before a system import (running: ${running.join(', ')})`
      );
    }

    const plan = this.planCollisions(archive, sections, opts);
    const missingEnv = (manifest.security?.requiredEnv ?? [])
      .filter((entry) => !process.env[entry.variable])
      .map((entry) => entry.variable);

    // A dry run reports collisions rather than refusing on them — showing the
    // operator what is in the way is the entire point of asking.
    if (opts.dryRun) {
      return {
        dryRun: true,
        sections,
        agents: [],
        filesWritten: 0,
        collisions: plan,
        warnings,
        missingEnv,
        manifest,
      };
    }

    if (plan.length > 0 && !opts.overwrite) {
      throw new ConflictError(
        `Target already has ${plan.length} item(s) that this import would replace. Re-run with overwrite=true to proceed. First conflicts: ${plan
          .slice(0, 10)
          .join(', ')}${plan.length > 10 ? ', ...' : ''}`
      );
    }

    let filesWritten = 0;
    if (sections.includes('config')) {
      filesWritten += this.restoreGlobalConfig(archive, warnings);
    }

    const agents: ImportedAgent[] = [];
    if (sections.includes('agents')) {
      const restored = await this.restoreAgents(archive, opts, warnings);
      agents.push(...restored.agents);
      filesWritten += restored.filesWritten;
    }

    if (sections.includes('data')) {
      filesWritten += this.restoreDataDirectories(archive, warnings);
    }
    if (sections.includes('tenants')) {
      filesWritten += this.restoreTenantTree(archive);
    }

    if (missingEnv.length > 0) {
      warnings.push(
        `${missingEnv.length} required environment variable(s) are not set on this machine — see REQUIRED_ENV.txt: ${missingEnv.join(', ')}`
      );
    }

    this.deps.logger.info(
      { sections, agents: agents.length, filesWritten, missingEnv: missingEnv.length },
      'System import completed'
    );

    return {
      dryRun: false,
      sections,
      agents,
      filesWritten,
      collisions: plan,
      warnings,
      missingEnv,
      manifest,
    };
  }

  /** Everything the restore would replace, computed before any write. */
  private planCollisions(
    archive: TarArchive,
    sections: SystemSection[],
    opts: SystemImportOptions
  ): string[] {
    const collisions: string[] = [];

    if (sections.includes('config') && existsSync(this.deps.configPath)) {
      collisions.push('config/config.json');
    }

    if (sections.includes('agents')) {
      const existingIds = new Set(this.existingRoster().map((bot) => bot.id));
      for (const botId of this.bundleAgentIds(archive, opts)) {
        if (existingIds.has(botId)) collisions.push(`agent:${botId}`);
      }
    }

    if (sections.includes('data')) {
      for (const { archivePath, hostPath } of this.targetDataPaths()) {
        collisions.push(...this.fileCollisions(archive, archivePath, hostPath));
      }
    }

    if (sections.includes('tenants')) {
      const tenantsDir = this.resolvePath(
        pickString(this.deps.config as unknown, ['multiTenant', 'dataDir'], PATH_DEFAULTS.tenants)
      );
      collisions.push(...this.fileCollisions(archive, 'tenants', tenantsDir));
    }

    return collisions;
  }

  private fileCollisions(archive: TarArchive, prefix: string, hostDir: string): string[] {
    const collisions: string[] = [];
    for (const path of subtree(archive, prefix).files.keys()) {
      if (existsSync(join(hostDir, ...path.split('/')))) collisions.push(`${prefix}/${path}`);
    }
    return collisions;
  }

  private existingRoster(): BotConfig[] {
    if (this.deps.config) return this.deps.config.bots;
    const botsPath = botsPathFromConfigPath(this.deps.configPath);
    if (!existsSync(botsPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(botsPath, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private bundleAgentIds(archive: TarArchive, opts: SystemImportOptions): string[] {
    const ids = subtreeChildren(archive, 'agents');
    return opts.agentIds?.length ? ids.filter((id) => opts.agentIds?.includes(id)) : ids;
  }

  private restoreGlobalConfig(archive: TarArchive, warnings: string[]): number {
    const data = archive.files.get('config/config.json');
    if (!data) {
      warnings.push('Bundle declares a config section but contains no config/config.json');
      return 0;
    }

    mkdirSync(dirname(this.deps.configPath), { recursive: true });
    if (existsSync(this.deps.configPath)) {
      // The previous config is the only copy of settings the bundle drops as
      // machine-specific, so it is preserved next to the new one.
      const backup = `${this.deps.configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(this.deps.configPath, backup);
      warnings.push(`Previous config saved to ${backup}`);
    }
    writeFileSync(this.deps.configPath, data);
    return 1;
  }

  private async restoreAgents(
    archive: TarArchive,
    opts: SystemImportOptions,
    warnings: string[]
  ): Promise<{ agents: ImportedAgent[]; filesWritten: number }> {
    const roster = [...this.existingRoster()];
    const config = this.effectiveConfig(roster);
    const service = new BotExportService(
      config,
      this.deps.configPath,
      this.deps.logger,
      this.deps.getCoreMemory,
      this.deps.onSoulFilesImported
    );

    const rosterData = archive.files.get('config/bots.json');
    const bundleRoster: Record<string, unknown>[] = rosterData
      ? JSON.parse(rosterData.toString('utf-8'))
      : [];

    const agents: ImportedAgent[] = [];
    let filesWritten = 0;

    for (const botId of this.bundleAgentIds(archive, opts)) {
      const botArchive = subtree(archive, `agents/${botId}`);
      if (!botArchive.files.has('manifest.json')) {
        warnings.push(`Skipping agent "${botId}": nested bundle has no manifest.json`);
        continue;
      }

      try {
        const result = await service.restoreBotArchive(botArchive, {
          overwrite: opts.overwrite,
          persistRoster: false,
        });
        agents.push(result);
        filesWritten += botArchive.files.size;
      } catch (err) {
        if (err instanceof ConflictError) throw err;
        warnings.push(
          `Agent "${botId}" failed to import: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Carry roster-level settings that live only in bots.json for bots whose
    // payload was skipped, then write the roster exactly once.
    for (const entry of bundleRoster) {
      const botId = String(entry.id);
      if (agents.some((agent) => agent.botId === botId)) continue;
      if (opts.agentIds?.length && !opts.agentIds.includes(botId)) continue;
      if (config.bots.some((bot) => bot.id === botId)) continue;
      config.bots.push({ ...(entry as unknown as BotConfig), token: '', enabled: false });
      warnings.push(`Agent "${botId}" restored from the roster only (no payload in the bundle)`);
    }

    persistBots(this.deps.configPath, config.bots);
    if (this.deps.config) this.deps.config.bots = config.bots;

    return { agents, filesWritten };
  }

  private restoreDataDirectories(archive: TarArchive, warnings: string[]): number {
    let written = 0;
    for (const { archivePath, hostPath } of this.targetDataPaths()) {
      if (!hasSubtree(archive, archivePath)) continue;
      written += writeArchiveToDisk(subtree(archive, archivePath), hostPath);
    }

    const contacts = archive.files.get('data/contacts.json');
    if (contacts) {
      const contactsPath = this.resolvePath(
        pickString(
          this.deps.config as unknown,
          ['phoneCall', 'contactsFile'],
          PATH_DEFAULTS.contacts
        )
      );
      mkdirSync(dirname(contactsPath), { recursive: true });
      writeFileSync(contactsPath, contacts);
      written++;
      warnings.push(
        'Contacts restored with credential-shaped fields blanked — re-enter them on this instance'
      );
    }
    return written;
  }

  private restoreTenantTree(archive: TarArchive): number {
    if (!hasSubtree(archive, 'tenants')) return 0;
    const tenantsDir = this.resolvePath(
      pickString(this.deps.config as unknown, ['multiTenant', 'dataDir'], PATH_DEFAULTS.tenants)
    );
    return writeArchiveToDisk(subtree(archive, 'tenants'), tenantsDir);
  }
}

/** True when a directory exists and contains anything. */
export function isPopulatedDirectory(path: string): boolean {
  try {
    return existsSync(path) && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

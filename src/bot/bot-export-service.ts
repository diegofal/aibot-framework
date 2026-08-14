import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  };
}

/** `.versions/` is soul-file history: large, regenerable, and never restored. */
function excludeSoulVersions(relativePath: string): boolean {
  return !relativePath.split('/').includes('.versions');
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

    const resolved = resolveAgentConfig(this.config, botConfig);
    const entries: TarEntry[] = [];

    // The roster sanitizer is the single place that knows which bot fields are
    // credentials, so per-bot and system exports strip the same set.
    const { bots: sanitized } = sanitizeBotRoster([structuredClone(botConfig)]);
    const sanitizedConfig = sanitized[0] as BotConfig;
    entries.push({
      path: 'config.json',
      data: Buffer.from(JSON.stringify(sanitizedConfig, null, 2), 'utf-8'),
    });

    const soulDir = resolved.soulDir;
    if (existsSync(soulDir)) {
      entries.push(
        ...collectDirEntries(soulDir, 'soul', { filter: (path) => excludeSoulVersions(path) })
      );
    } else {
      entries.push({ path: 'soul' });
      this.logger.warn({ botId, soulDir }, 'Export: soul directory missing, exporting empty');
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

    if (opts.productions) {
      const prodDir = botConfig.productions?.dir ?? join(this.config.productions.baseDir, botId);
      if (existsSync(prodDir)) entries.push(...collectDirEntries(prodDir, 'productions'));
    }
    if (opts.conversations) {
      const convDir = join(this.config.conversations.baseDir, botId);
      if (existsSync(convDir)) entries.push(...collectDirEntries(convDir, 'conversations'));
    }
    if (opts.karma) {
      const karmaDir = join(this.config.karma.baseDir, botId);
      if (existsSync(karmaDir)) entries.push(...collectDirEntries(karmaDir, 'karma'));
    }

    const manifest: ExportManifest = {
      version: EXPORT_VERSION,
      botId,
      botName: botConfig.name,
      exportDate: new Date().toISOString(),
      includes: {
        soul: true,
        coreMemory: coreMemoryExported,
        productions: !!opts.productions,
        conversations: !!opts.conversations,
        karma: !!opts.karma,
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
      { botId, size: buffer.length, productions: !!opts.productions },
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

    // `close(true)` releases the file handle immediately. A deferred close
    // leaves the SQLite file locked on Windows, which turns any follow-up
    // operation on the data directory into an EBUSY failure.
    fallbackDb?.close(true);
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

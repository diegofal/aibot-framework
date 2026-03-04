import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { BotConfig, Config } from '../config';
import { persistBots, resolveAgentConfig } from '../config';
import type { Logger } from '../logger';
import { type CoreMemoryManager, createCoreMemoryManager } from '../memory/core-memory';
import { initializeMemoryDb } from '../memory/schema';

const EXPORT_VERSION = 1;

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

export class BotExportService {
  constructor(
    private config: Config,
    private configPath: string,
    private logger: Logger,
    private getCoreMemory?: () => CoreMemoryManager | null,
    private onSoulFilesImported?: () => Promise<void>
  ) {}

  async exportBot(botId: string, opts: ExportOptions = {}): Promise<Buffer> {
    const botConfig = this.config.bots.find((b) => b.id === botId);
    if (!botConfig) throw new Error(`Bot not found: ${botId}`);

    const resolved = resolveAgentConfig(this.config, botConfig);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const stagingDir = join('/tmp', `aibot-export-${botId}-${ts}`);

    try {
      mkdirSync(stagingDir, { recursive: true });

      let coreMemoryExported = false;

      // 1. Write sanitized config (no token, no apiKey)
      const sanitizedConfig: BotConfig = {
        ...structuredClone(botConfig),
        token: '',
      };
      writeFileSync(
        join(stagingDir, 'config.json'),
        JSON.stringify(sanitizedConfig, null, 2),
        'utf-8'
      );

      // 3. Copy soul directory (exclude .versions/)
      const soulDir = resolved.soulDir;
      const soulStaging = join(stagingDir, 'soul');
      if (existsSync(soulDir)) {
        cpSync(soulDir, soulStaging, {
          recursive: true,
          filter: (src) => !src.includes('.versions'),
        });
      } else {
        mkdirSync(soulStaging, { recursive: true });
        this.logger.warn({ botId, soulDir }, 'Export: soul directory missing, exporting empty');
      }

      // 4. Dump core_memory as JSONL
      const coreMemory = this.getCoreMemory?.();
      if (coreMemory) {
        try {
          const entries = await coreMemory.list(undefined, undefined, botId);
          if (entries.length > 0) {
            const lines = entries.map((e) => JSON.stringify(e));
            writeFileSync(join(stagingDir, 'core_memory.jsonl'), `${lines.join('\n')}\n`, 'utf-8');
            coreMemoryExported = true;
          }
        } catch (err) {
          this.logger.warn({ err, botId }, 'Export: failed to dump core memory');
        }
      }

      // 5. Optional: productions
      if (opts.productions) {
        const prodDir = botConfig.productions?.dir ?? join(this.config.productions.baseDir, botId);
        if (existsSync(prodDir)) {
          cpSync(prodDir, join(stagingDir, 'productions'), { recursive: true });
        }
      }

      // 6. Optional: conversations
      if (opts.conversations) {
        const convDir = join(this.config.conversations.baseDir, botId);
        if (existsSync(convDir)) {
          cpSync(convDir, join(stagingDir, 'conversations'), { recursive: true });
        }
      }

      // 7. Optional: karma
      if (opts.karma) {
        const karmaDir = join(this.config.karma.baseDir, botId);
        if (existsSync(karmaDir)) {
          cpSync(karmaDir, join(stagingDir, 'karma'), { recursive: true });
        }
      }

      // 8. Write manifest (after all data collection so flags are accurate)
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
      writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

      // 9. Create tar.gz via Bun.spawn
      const archiveName = `${botId}-export-${ts}.tar.gz`;
      const archivePath = join('/tmp', archiveName);

      const proc = Bun.spawn(['tar', '-czf', archivePath, '-C', stagingDir, '.'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      if (proc.exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`tar failed: ${stderr}`);
      }

      const buffer = readFileSync(archivePath);

      // Cleanup
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(archivePath, { force: true });

      this.logger.info(
        { botId, size: buffer.length, productions: !!opts.productions },
        'Bot exported successfully'
      );

      return buffer as Buffer;
    } catch (err) {
      rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    }
  }

  async importBot(buffer: Buffer, opts: ImportOptions = {}): Promise<ImportResult> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const stagingDir = join('/tmp', `aibot-import-${ts}`);
    const archivePath = join('/tmp', `aibot-import-${ts}.tar.gz`);
    const warnings: string[] = [];

    try {
      // 1. Extract tar.gz
      writeFileSync(archivePath, buffer);
      mkdirSync(stagingDir, { recursive: true });

      const proc = Bun.spawn(['tar', '-xzf', archivePath, '-C', stagingDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      if (proc.exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Failed to extract archive: ${stderr}`);
      }

      // 2. Validate manifest
      const manifestPath = join(stagingDir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        throw new Error('Invalid archive: missing manifest.json');
      }

      const manifest: ExportManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (manifest.version !== EXPORT_VERSION) {
        throw new Error(`Unsupported export version: ${manifest.version}`);
      }

      // 3. Read config and apply overrides
      const configPath = join(stagingDir, 'config.json');
      if (!existsSync(configPath)) {
        throw new Error('Invalid archive: missing config.json');
      }

      const importedConfig: BotConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      const botId = opts.newBotId ?? importedConfig.id;
      const botName = opts.newBotName ?? importedConfig.name;

      // 4. Check for conflicts
      const existing = this.config.bots.find((b) => b.id === botId);
      if (existing && !opts.overwrite) {
        throw new ConflictError(`Bot "${botId}" already exists. Use overwrite=true to replace.`);
      }
      if (existing && opts.overwrite) {
        // Find the bot by checking if it's running — can't overwrite running bots
        // The route handler will check this, but we include a warning
        warnings.push(`Overwriting existing bot "${botId}"`);
      }

      // 5. Copy soul directory
      const targetSoulDir = resolve(this.config.soul.dir, botId);
      const sourceSoul = join(stagingDir, 'soul');
      if (existsSync(sourceSoul)) {
        if (existing && opts.overwrite && existsSync(targetSoulDir)) {
          rmSync(targetSoulDir, { recursive: true, force: true });
        }
        mkdirSync(targetSoulDir, { recursive: true });
        cpSync(sourceSoul, targetSoulDir, { recursive: true });

        // Re-index soul files so RAG search can find them immediately
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

      // 6. Re-insert core_memory
      const coreMemoryPath = join(stagingDir, 'core_memory.jsonl');
      if (existsSync(coreMemoryPath)) {
        let coreMemory = this.getCoreMemory?.();
        let fallbackDb: ReturnType<typeof initializeMemoryDb> | null = null;

        if (!coreMemory) {
          const dbPath = this.config.soul?.search?.dbPath ?? './data/memory.db';
          try {
            fallbackDb = initializeMemoryDb(dbPath, this.logger);
            coreMemory = createCoreMemoryManager(fallbackDb, this.logger);
            this.logger.info(
              { dbPath },
              'Import: using standalone CoreMemoryManager (no Ollama required)'
            );
          } catch (err) {
            this.logger.warn(
              { err, dbPath },
              'Import: failed to open memory database for fallback'
            );
            warnings.push(`Core memory data found but could not open database: ${err}`);
          }
        }

        if (coreMemory) {
          const lines = readFileSync(coreMemoryPath, 'utf-8').trim().split('\n');
          let imported = 0;
          for (const line of lines) {
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
          if (imported > 0) {
            this.logger.info({ botId, imported }, 'Import: core memory entries restored');
          }
        }

        if (fallbackDb) {
          fallbackDb.close();
        }
      }

      // 7. Optional: restore productions
      const prodSource = join(stagingDir, 'productions');
      if (existsSync(prodSource)) {
        const prodTarget = join(this.config.productions.baseDir, botId);
        if (existing && opts.overwrite && existsSync(prodTarget)) {
          rmSync(prodTarget, { recursive: true, force: true });
        }
        mkdirSync(prodTarget, { recursive: true });
        cpSync(prodSource, prodTarget, { recursive: true });
      }

      // 8. Optional: restore conversations
      const convSource = join(stagingDir, 'conversations');
      if (existsSync(convSource)) {
        const convTarget = join(this.config.conversations.baseDir, botId);
        if (existing && opts.overwrite && existsSync(convTarget)) {
          rmSync(convTarget, { recursive: true, force: true });
        }
        mkdirSync(convTarget, { recursive: true });
        cpSync(convSource, convTarget, { recursive: true });
      }

      // 9. Optional: restore karma
      const karmaSource = join(stagingDir, 'karma');
      if (existsSync(karmaSource)) {
        const karmaTarget = join(this.config.karma.baseDir, botId);
        if (existing && opts.overwrite && existsSync(karmaTarget)) {
          rmSync(karmaTarget, { recursive: true, force: true });
        }
        mkdirSync(karmaTarget, { recursive: true });
        cpSync(karmaSource, karmaTarget, { recursive: true });
      }

      // 10. Push new BotConfig
      const newConfig: BotConfig = {
        ...importedConfig,
        id: botId,
        name: botName,
        token: '',
        enabled: false,
      };

      if (existing && opts.overwrite) {
        const idx = this.config.bots.findIndex((b) => b.id === botId);
        // Preserve existing token
        newConfig.token = existing.token ?? '';
        this.config.bots[idx] = newConfig;
      } else {
        this.config.bots.push(newConfig);
      }
      persistBots(this.configPath, this.config.bots);

      // Cleanup
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(archivePath, { force: true });

      this.logger.info({ botId, botName, warnings }, 'Bot imported successfully');

      return {
        botId,
        botName,
        warnings,
        created: !existing || !opts.overwrite,
      };
    } catch (err) {
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(archivePath, { force: true });
      throw err;
    }
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

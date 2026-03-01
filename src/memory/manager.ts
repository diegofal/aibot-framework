import type { Database } from 'bun:sqlite';
import { readFileSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join, relative } from 'node:path';
import type { MemorySearchConfig } from '../config';
import type { Logger } from '../logger';
import type { OllamaClient } from '../ollama';
import { type CoreMemoryManager, createCoreMemoryManager } from './core-memory';
import { type EmbeddingService, createEmbeddingService } from './embeddings';
import { fullReindex, indexFile } from './indexer';
import { initializeMemoryDb } from './schema';
import { hybridSearch } from './search';
import { indexAllSessions } from './session-indexer';
import type { MemorySearchResult } from './types';

export class MemoryManager {
  private db: Database | null = null;
  private embeddingService: EmbeddingService | null = null;
  private coreMemoryManager: CoreMemoryManager | null = null;
  private watcher: FSWatcher | null = null;
  private pendingPaths = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private soulDir: string,
    private config: MemorySearchConfig,
    private ollama: OllamaClient,
    private logger: Logger,
    private transcriptsDir?: string
  ) {}

  async initialize(): Promise<void> {
    // Initialize database
    this.db = initializeMemoryDb(this.config.dbPath, this.logger);

    // Create embedding service
    this.embeddingService = createEmbeddingService(
      this.db,
      this.ollama,
      this.config.embeddingModel,
      this.config.concurrency,
      this.logger
    );

    // Initialize core memory manager
    this.coreMemoryManager = createCoreMemoryManager(this.db, this.logger);

    // Full reindex on startup
    await fullReindex(this.db, this.soulDir, this.embeddingService, this.config, this.logger);

    // Start file watcher
    if (this.config.watchEnabled) {
      this.startWatcher();
    }
  }

  /**
   * Get the core memory manager for structured identity storage.
   * Returns null if not initialized.
   */
  getCoreMemory(): CoreMemoryManager | null {
    return this.coreMemoryManager;
  }

  async search(
    query: string,
    maxResults?: number,
    minScore?: number,
    botId?: string
  ): Promise<MemorySearchResult[]> {
    if (!this.db || !this.embeddingService) {
      throw new Error('MemoryManager not initialized');
    }
    return hybridSearch(this.db, query, this.embeddingService, this.config, this.logger, {
      maxResults,
      minScore,
      botId,
    });
  }

  getFileLines(
    relPath: string,
    fromLine?: number,
    lineCount?: number,
    botId?: string
  ): string | null {
    // Auto-prefix path with botId if provided and path doesn't already start with it
    let effectivePath = relPath;
    if (botId && !relPath.startsWith(`${botId}/`)) {
      effectivePath = `${botId}/${relPath}`;
    }
    const fullPath = join(this.soulDir, effectivePath);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const start = (fromLine ?? 1) - 1; // convert to 0-indexed
      const count = lineCount ?? lines.length;
      const slice = lines.slice(start, start + count);

      return slice.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
    } catch {
      return null;
    }
  }

  async reindexFile(relPath: string): Promise<void> {
    if (!this.db || !this.embeddingService) return;
    await indexFile(
      this.db,
      this.soulDir,
      relPath,
      this.embeddingService,
      this.config,
      this.logger
    );
  }

  /**
   * Index all session transcripts from the transcripts directory.
   * Only works when transcriptsDir was provided at construction time.
   */
  async indexSessions(): Promise<void> {
    if (!this.db || !this.embeddingService || !this.transcriptsDir) return;
    await indexAllSessions(
      this.db,
      this.transcriptsDir,
      this.embeddingService,
      this.config,
      this.logger
    );
  }

  /**
   * Delete all core memory entries.
   */
  clearCoreMemory(): void {
    if (!this.db) return;
    this.db.exec('DELETE FROM core_memory');
    this.logger.info('Core memory cleared');
  }

  /**
   * Delete all indexed files/chunks and rebuild FTS.
   */
  clearIndex(): void {
    if (!this.db) return;
    this.db.exec('DELETE FROM chunks');
    this.db.exec('DELETE FROM files');
    // Rebuild FTS index after clearing
    this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    this.logger.info('Memory index cleared');
  }

  /**
   * Delete indexed files/chunks for a specific bot (by path prefix) and clean orphaned embeddings.
   */
  clearIndexForBot(botId: string): number {
    if (!this.db) return 0;
    const prefix = `${botId}/`;

    // Get file IDs matching this bot
    const files = this.db
      .prepare<{ id: number }, [string]>('SELECT id FROM files WHERE path LIKE ?')
      .all(`${prefix}%`);

    if (files.length === 0) return 0;

    // Collect content_hashes of chunks being deleted (for embedding_cache cleanup)
    const fileIds = files.map((f) => f.id);
    const placeholders = fileIds.map(() => '?').join(',');
    const orphanHashes = this.db
      .prepare<{ content_hash: string }, number[]>(
        `SELECT DISTINCT content_hash FROM chunks WHERE file_id IN (${placeholders})`
      )
      .all(...fileIds);

    // Delete chunks and files for this bot
    this.db.exec(
      `DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE path LIKE '${prefix}%')`
    );
    const deleted = this.db
      .prepare('DELETE FROM files WHERE path LIKE ?')
      .run(`${prefix}%`).changes;

    // Clean orphaned embedding_cache entries (hashes no longer referenced by any chunk)
    for (const { content_hash } of orphanHashes) {
      const stillUsed = this.db
        .prepare<{ c: number }, [string]>('SELECT COUNT(*) as c FROM chunks WHERE content_hash = ?')
        .get(content_hash);
      if (stillUsed && stillUsed.c === 0) {
        this.db.prepare('DELETE FROM embedding_cache WHERE content_hash = ?').run(content_hash);
      }
    }

    // Rebuild FTS index
    this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    this.logger.info({ botId, deleted }, 'Memory index cleared for bot');
    return deleted;
  }

  /**
   * Delete core memory entries for a specific bot using the bot_id column.
   */
  clearCoreMemoryForBot(botId: string): number {
    if (!this.db) return 0;
    const result = this.db.prepare('DELETE FROM core_memory WHERE bot_id = ?').run(botId);
    this.logger.info({ botId, cleared: result.changes }, 'Core memory cleared for bot');
    return result.changes;
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.logger.info('MemoryManager disposed');
  }

  private startWatcher(): void {
    try {
      this.watcher = watch(this.soulDir, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith('.md')) return;

        // Normalize path separator for consistency
        const relPath = filename.replace(/\\/g, '/');
        this.pendingPaths.add(relPath);

        // Debounce: accumulate changes, process after interval
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
          this.processPendingChanges();
        }, this.config.syncIntervalMs);
      });

      this.logger.info({ soulDir: this.soulDir }, 'File watcher started');
    } catch (err) {
      this.logger.warn(
        { err },
        'Failed to start file watcher — changes will require manual reindex'
      );
    }
  }

  private async processPendingChanges(): Promise<void> {
    if (!this.db || !this.embeddingService) return;

    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();

    for (const relPath of paths) {
      try {
        await indexFile(
          this.db,
          this.soulDir,
          relPath,
          this.embeddingService,
          this.config,
          this.logger
        );
      } catch (err) {
        this.logger.warn({ err, path: relPath }, 'Failed to reindex file on change');
      }
    }
  }
}

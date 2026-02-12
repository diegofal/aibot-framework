import { watch, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { FSWatcher } from 'node:fs';
import type { Logger } from '../logger';
import type { MemorySearchConfig } from '../config';
import type { OllamaClient } from '../ollama';
import type { MemorySearchResult } from './types';
import { initializeMemoryDb } from './schema';
import { createEmbeddingService, type EmbeddingService } from './embeddings';
import { fullReindex, indexFile } from './indexer';
import { hybridSearch } from './search';

export class MemoryManager {
  private db: Database | null = null;
  private embeddingService: EmbeddingService | null = null;
  private watcher: FSWatcher | null = null;
  private pendingPaths = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private soulDir: string,
    private config: MemorySearchConfig,
    private ollama: OllamaClient,
    private logger: Logger,
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
      this.logger,
    );

    // Full reindex on startup
    await fullReindex(this.db, this.soulDir, this.embeddingService, this.config, this.logger);

    // Start file watcher
    if (this.config.watchEnabled) {
      this.startWatcher();
    }
  }

  async search(query: string, maxResults?: number, minScore?: number): Promise<MemorySearchResult[]> {
    if (!this.db || !this.embeddingService) {
      throw new Error('MemoryManager not initialized');
    }
    return hybridSearch(this.db, query, this.embeddingService, this.config, this.logger, {
      maxResults,
      minScore,
    });
  }

  getFileLines(relPath: string, fromLine?: number, lineCount?: number): string | null {
    const fullPath = join(this.soulDir, relPath);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const start = (fromLine ?? 1) - 1; // convert to 0-indexed
      const count = lineCount ?? lines.length;
      const slice = lines.slice(start, start + count);

      return slice
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join('\n');
    } catch {
      return null;
    }
  }

  async reindexFile(relPath: string): Promise<void> {
    if (!this.db || !this.embeddingService) return;
    await indexFile(this.db, this.soulDir, relPath, this.embeddingService, this.config, this.logger);
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
      this.logger.warn({ err }, 'Failed to start file watcher — changes will require manual reindex');
    }
  }

  private async processPendingChanges(): Promise<void> {
    if (!this.db || !this.embeddingService) return;

    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();

    for (const relPath of paths) {
      try {
        await indexFile(this.db, this.soulDir, relPath, this.embeddingService, this.config, this.logger);
      } catch (err) {
        this.logger.warn({ err, path: relPath }, 'Failed to reindex file on change');
      }
    }
  }
}

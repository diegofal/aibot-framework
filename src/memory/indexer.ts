import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Logger } from '../logger';
import type { MemorySearchConfig } from '../config';
import type { EmbeddingService } from './embeddings';
import { contentHash, chunkMarkdown } from './chunker';
import { serializeEmbedding } from './schema';

/**
 * Recursively discover all .md files under soulDir
 */
export function discoverFiles(soulDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(relative(soulDir, fullPath));
      }
    }
  }

  walk(soulDir);
  return results;
}

/**
 * Index a single file. Returns the number of chunks indexed (0 if unchanged).
 */
export async function indexFile(
  db: Database,
  soulDir: string,
  relPath: string,
  embeddingService: EmbeddingService,
  config: MemorySearchConfig,
  logger: Logger,
): Promise<number> {
  const fullPath = join(soulDir, relPath);

  let content: string;
  try {
    content = readFileSync(fullPath, 'utf-8');
  } catch {
    logger.warn({ path: relPath }, 'Could not read file for indexing');
    return 0;
  }

  if (!content.trim()) {
    // Empty file — remove if previously indexed
    removeFile(db, relPath, logger);
    return 0;
  }

  const hash = contentHash(content);

  // Check if file is already indexed with the same hash
  const existing = db.prepare<{ content_hash: string }, [string]>(
    'SELECT content_hash FROM files WHERE path = ?'
  ).get(relPath);

  if (existing && existing.content_hash === hash) {
    logger.debug({ path: relPath }, 'File unchanged, skipping');
    return 0;
  }

  // Remove old data if re-indexing
  if (existing) {
    removeFile(db, relPath, logger);
  }

  // Chunk the content
  const chunks = chunkMarkdown(content, {
    targetTokens: config.chunkTargetTokens,
    overlapTokens: config.chunkOverlapTokens,
  });

  if (chunks.length === 0) {
    return 0;
  }

  // Generate embeddings for all chunks
  const embedItems = chunks.map(c => ({ hash: c.contentHash, text: c.content }));
  const embeddings = await embeddingService.embedBatch(embedItems);

  // Insert file record
  const insertFile = db.prepare(
    'INSERT INTO files (path, content_hash, last_indexed_at, chunk_count) VALUES (?, ?, datetime(\'now\'), ?)'
  );
  insertFile.run(relPath, hash, chunks.length);

  const fileRow = db.prepare<{ id: number }, [string]>('SELECT id FROM files WHERE path = ?').get(relPath);
  if (!fileRow) {
    throw new Error(`Failed to insert file record for ${relPath}`);
  }
  const fileId = fileRow.id;

  // Insert chunks
  const insertChunk = db.prepare(
    'INSERT INTO chunks (file_id, chunk_index, content, start_line, end_line, token_estimate, content_hash, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const insertAll = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings.get(chunk.contentHash);
      insertChunk.run(
        fileId,
        i,
        chunk.content,
        chunk.startLine,
        chunk.endLine,
        chunk.tokenEstimate,
        chunk.contentHash,
        embedding ? serializeEmbedding(embedding) : null,
      );
    }
  });

  insertAll();

  logger.info({ path: relPath, chunks: chunks.length }, 'File indexed');
  return chunks.length;
}

/**
 * Remove a file and its chunks from the database
 */
export function removeFile(db: Database, relPath: string, logger: Logger): void {
  const fileRow = db.prepare<{ id: number }, [string]>('SELECT id FROM files WHERE path = ?').get(relPath);
  if (!fileRow) return;

  db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileRow.id);
  db.prepare('DELETE FROM files WHERE id = ?').run(fileRow.id);
  logger.debug({ path: relPath }, 'File removed from index');
}

/**
 * Full reindex: discover all files, index changed ones, prune stale entries
 */
export async function fullReindex(
  db: Database,
  soulDir: string,
  embeddingService: EmbeddingService,
  config: MemorySearchConfig,
  logger: Logger,
): Promise<{ indexed: number; removed: number; total: number }> {
  const discoveredFiles = discoverFiles(soulDir);
  let indexed = 0;
  let total = 0;

  for (const relPath of discoveredFiles) {
    const chunks = await indexFile(db, soulDir, relPath, embeddingService, config, logger);
    if (chunks > 0) indexed++;
    total += chunks;
  }

  // Prune files that no longer exist on disk
  const dbFiles = db.prepare<{ path: string }, []>('SELECT path FROM files').all();
  let removed = 0;
  for (const { path } of dbFiles) {
    if (!discoveredFiles.includes(path)) {
      removeFile(db, path, logger);
      removed++;
    }
  }

  logger.info({ indexed, removed, totalChunks: total, files: discoveredFiles.length }, 'Full reindex complete');
  return { indexed, removed, total };
}

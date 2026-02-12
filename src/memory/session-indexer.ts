import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Logger } from '../logger';
import type { MemorySearchConfig } from '../config';
import type { EmbeddingService } from './embeddings';
import { contentHash, chunkMarkdown } from './chunker';
import { serializeEmbedding } from './schema';

/**
 * Convert a JSONL transcript file into plain text suitable for chunking/embedding.
 * Each line is a JSON object with { role, content }.
 */
export function transcriptToText(jsonlPath: string): string {
  let content: string;
  try {
    content = readFileSync(jsonlPath, 'utf-8').trim();
  } catch {
    return '';
  }

  if (!content) return '';

  const lines = content.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as { role: string; content: string };
      if (msg.role === 'user' || msg.role === 'assistant') {
        textLines.push(`${msg.role}: ${msg.content}`);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return textLines.join('\n');
}

/**
 * Index a single session transcript into the memory database.
 * Uses source_type = 'session' to distinguish from soul memory files.
 */
export async function indexSessionTranscript(
  db: Database,
  transcriptPath: string,
  sessionKey: string,
  embeddingService: EmbeddingService,
  config: MemorySearchConfig,
  logger: Logger,
): Promise<number> {
  const text = transcriptToText(transcriptPath);
  if (!text) return 0;

  const hash = contentHash(text);
  const relPath = `sessions/${sessionKey}`;

  // Check if already indexed with same hash
  const existing = db.prepare<{ content_hash: string }, [string]>(
    'SELECT content_hash FROM files WHERE path = ?'
  ).get(relPath);

  if (existing && existing.content_hash === hash) {
    logger.debug({ path: relPath }, 'Session transcript unchanged, skipping');
    return 0;
  }

  // Remove old data if re-indexing
  if (existing) {
    const fileRow = db.prepare<{ id: number }, [string]>('SELECT id FROM files WHERE path = ?').get(relPath);
    if (fileRow) {
      db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileRow.id);
      db.prepare('DELETE FROM files WHERE id = ?').run(fileRow.id);
    }
  }

  // Chunk the text content
  const chunks = chunkMarkdown(text, {
    targetTokens: config.chunkTargetTokens,
    overlapTokens: config.chunkOverlapTokens,
  });

  if (chunks.length === 0) return 0;

  // Generate embeddings
  const embedItems = chunks.map((c) => ({ hash: c.contentHash, text: c.content }));
  const embeddings = await embeddingService.embedBatch(embedItems);

  // Insert file record with source_type = 'session'
  const insertFile = db.prepare(
    "INSERT INTO files (path, content_hash, last_indexed_at, chunk_count, source_type) VALUES (?, ?, datetime('now'), ?, 'session')"
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
  logger.info({ path: relPath, chunks: chunks.length }, 'Session transcript indexed');
  return chunks.length;
}

/**
 * Index all JSONL session transcripts in the given directory.
 */
export async function indexAllSessions(
  db: Database,
  transcriptsDir: string,
  embeddingService: EmbeddingService,
  config: MemorySearchConfig,
  logger: Logger,
): Promise<{ indexed: number; totalChunks: number }> {
  let files: string[];
  try {
    files = readdirSync(transcriptsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    logger.warn({ dir: transcriptsDir }, 'Could not read transcripts directory');
    return { indexed: 0, totalChunks: 0 };
  }

  let indexed = 0;
  let totalChunks = 0;

  for (const file of files) {
    const fullPath = join(transcriptsDir, file);
    // Derive session key from filename (strip .jsonl extension)
    const sessionKey = basename(file, '.jsonl');
    try {
      const chunks = await indexSessionTranscript(db, fullPath, sessionKey, embeddingService, config, logger);
      if (chunks > 0) {
        indexed++;
        totalChunks += chunks;
      }
    } catch (err) {
      logger.warn({ err, file }, 'Failed to index session transcript');
    }
  }

  logger.info({ indexed, totalChunks, files: files.length }, 'Session transcript indexing complete');
  return { indexed, totalChunks };
}

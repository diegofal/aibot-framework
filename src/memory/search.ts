import type { Database } from 'bun:sqlite';
import type { Logger } from '../logger';
import type { MemorySearchConfig } from '../config';
import type { EmbeddingService } from './embeddings';
import type { MemorySearchResult } from './types';
import { deserializeEmbedding } from './schema';

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

interface SearchOpts {
  maxResults?: number;
  minScore?: number;
}

interface ChunkRow {
  id: number;
  content: string;
  start_line: number;
  end_line: number;
  embedding: Buffer | null;
  file_path: string;
}

interface FtsRow {
  rowid: number;
  rank: number;
}

export async function hybridSearch(
  db: Database,
  query: string,
  embeddingService: EmbeddingService,
  config: MemorySearchConfig,
  logger: Logger,
  opts?: SearchOpts,
): Promise<MemorySearchResult[]> {
  const maxResults = opts?.maxResults ?? config.defaultMaxResults;
  const minScore = opts?.minScore ?? config.defaultMinScore;

  // Score maps: chunkId → score
  const vectorScores = new Map<number, number>();
  const keywordScores = new Map<number, number>();

  // --- Vector search ---
  try {
    const queryEmbedding = await embeddingService.getEmbedding(
      `query:${query}`, // prefix to distinguish from chunk hashes
      query,
    );

    const allChunks = db.prepare<ChunkRow, []>(
      `SELECT c.id, c.content, c.start_line, c.end_line, c.embedding, f.path as file_path
       FROM chunks c JOIN files f ON c.file_id = f.id
       WHERE c.embedding IS NOT NULL`
    ).all();

    for (const chunk of allChunks) {
      if (!chunk.embedding) continue;
      const chunkEmb = deserializeEmbedding(chunk.embedding);
      const sim = cosineSimilarity(queryEmbedding, chunkEmb);
      if (sim > 0) {
        vectorScores.set(chunk.id, sim);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Vector search failed, falling back to keyword-only');
  }

  // --- Keyword search (FTS5) ---
  try {
    // Sanitize query for FTS5: remove special chars, wrap tokens in quotes
    const ftsQuery = query
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(t => `"${t}"`)
      .join(' OR ');

    if (ftsQuery) {
      const ftsResults = db.prepare<FtsRow, [string]>(
        `SELECT rowid, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 50`
      ).all(ftsQuery);

      for (const row of ftsResults) {
        // BM25 rank is negative (lower = better), convert to 0-1 score
        const score = 1 / (1 + Math.abs(row.rank));
        keywordScores.set(row.rowid, score);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Keyword search failed, falling back to vector-only');
  }

  // --- Merge scores ---
  const allChunkIds = new Set([...vectorScores.keys(), ...keywordScores.keys()]);
  const merged: { chunkId: number; score: number; source: 'vector' | 'keyword' | 'both' }[] = [];

  for (const chunkId of allChunkIds) {
    const vScore = vectorScores.get(chunkId) ?? 0;
    const kScore = keywordScores.get(chunkId) ?? 0;
    const score = config.vectorWeight * vScore + config.keywordWeight * kScore;

    let source: 'vector' | 'keyword' | 'both';
    if (vScore > 0 && kScore > 0) source = 'both';
    else if (vScore > 0) source = 'vector';
    else source = 'keyword';

    if (score >= minScore) {
      merged.push({ chunkId, score, source });
    }
  }

  // Sort by score descending and limit
  merged.sort((a, b) => b.score - a.score);
  const topResults = merged.slice(0, maxResults);

  // Fetch chunk data for results
  const results: MemorySearchResult[] = [];
  const getChunk = db.prepare<ChunkRow, [number]>(
    `SELECT c.id, c.content, c.start_line, c.end_line, c.embedding, f.path as file_path
     FROM chunks c JOIN files f ON c.file_id = f.id
     WHERE c.id = ?`
  );

  for (const item of topResults) {
    const chunk = getChunk.get(item.chunkId);
    if (!chunk) continue;

    results.push({
      filePath: chunk.file_path,
      startLine: chunk.start_line,
      endLine: chunk.end_line,
      content: chunk.content,
      score: Math.round(item.score * 1000) / 1000,
      source: item.source,
    });
  }

  logger.debug(
    { query: query.slice(0, 50), results: results.length, vectorHits: vectorScores.size, keywordHits: keywordScores.size },
    'Hybrid search completed',
  );

  return results;
}

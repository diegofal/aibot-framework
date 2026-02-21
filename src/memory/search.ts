import type { Database } from 'bun:sqlite';
import type { Logger } from '../logger';
import type { MemorySearchConfig } from '../config';
import type { EmbeddingService } from './embeddings';
import type { MemorySearchResult } from './types';
import { deserializeEmbedding } from './schema';

// Extended result with importance weighting
export interface WeightedMemoryResult extends MemorySearchResult {
  importance: number; // 1-10, 0 for non-core memory
  category?: string;
}

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
  source_type: string;
}

interface FtsRow {
  rowid: number;
  rank: number;
}

const STOP_WORDS = new Set([
  // Spanish
  'a', 'al', 'con', 'de', 'del', 'el', 'en', 'es', 'la', 'las', 'lo', 'los',
  'me', 'mi', 'no', 'o', 'para', 'por', 'que', 'se', 'si', 'su', 'te', 'un',
  'una', 'y', 'como', 'cual', 'tiene', 'esta',
  // English
  'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'she', 'the', 'to',
  'was', 'we', 'with', 'you',
]);

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
      `SELECT c.id, c.content, c.start_line, c.end_line, c.embedding, f.path as file_path, f.source_type
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
    // Sanitize query for FTS5: remove special chars, filter stop words, prefix matching
    const ftsTokens = query
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(t => t.toLowerCase())
      .filter(t => t.length >= 3 && !STOP_WORDS.has(t));

    const ftsQuery = ftsTokens.map(t => `${t}*`).join(' OR ');

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

  // --- Core Memory search (importance-weighted) ---
  const coreMemoryResults: WeightedMemoryResult[] = [];
  try {
    const coreResults = searchCoreMemory(db, query);
    for (const result of coreResults) {
      coreMemoryResults.push(result);
    }
  } catch (err) {
    logger.debug({ err }, 'Core Memory search failed (table may not exist)');
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
    `SELECT c.id, c.content, c.start_line, c.end_line, c.embedding, f.path as file_path, f.source_type
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
      sourceType: (chunk.source_type as 'memory' | 'session') ?? 'memory',
    });
  }

  // Merge Core Memory results (they get priority boost based on importance)
  const mergedResults = mergeWithCoreMemory(results, coreMemoryResults, maxResults);

  logger.debug(
    { query: query.slice(0, 50), results: mergedResults.length, vectorHits: vectorScores.size, keywordHits: keywordScores.size, coreMemoryHits: coreMemoryResults.length },
    'Hybrid search completed',
  );

  return mergedResults;
}

// Core Memory row type
interface CoreMemoryRow {
  id: number;
  category: string;
  key: string;
  value: string;
  importance: number;
  updated_at: string;
}

/**
 * Search Core Memory with keyword matching and importance weighting.
 * Returns results sorted by relevance * importance.
 */
function searchCoreMemory(db: Database, query: string): WeightedMemoryResult[] {
  // Check if core_memory table exists
  const tableCheck = db.prepare<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='core_memory'"
  ).get();
  if (!tableCheck) return [];

  const tokens = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return [];

  // Search in both key and value
  const conditions = tokens.map(() => '(LOWER(key) LIKE ? OR LOWER(value) LIKE ?)').join(' OR ');
  const params = tokens.flatMap(t => [`%${t}%`, `%${t}%`]);

  const rows = db.prepare<CoreMemoryRow, string[]>(
    `SELECT id, category, key, value, importance, updated_at
     FROM core_memory
     WHERE ${conditions}
     ORDER BY importance DESC, updated_at DESC
     LIMIT 20`
  ).all(...params);

  const results: WeightedMemoryResult[] = [];
  for (const row of rows) {
    // Calculate match score based on token overlap
    const content = `${row.key} ${row.value}`.toLowerCase();
    const matches = tokens.filter(t => content.includes(t)).length;
    const matchScore = matches / tokens.length;

    // Weight by importance (1-10) - high importance gets boosted
    const importanceWeight = row.importance / 5; // 0.2 to 2.0
    const finalScore = Math.min(1, matchScore * importanceWeight);

    if (finalScore > 0.1) {
      results.push({
        filePath: `core_memory/${row.category}`,
        startLine: row.id,
        endLine: row.id,
        content: `[${row.importance}/10] ${row.key}: ${row.value}`,
        score: Math.round(finalScore * 1000) / 1000,
        source: 'keyword',
        sourceType: 'memory',
        importance: row.importance,
        category: row.category,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Merge regular search results with Core Memory results.
 * Core Memory results get boosted by importance and are deduplicated.
 */
function mergeWithCoreMemory(
  regularResults: MemorySearchResult[],
  coreResults: WeightedMemoryResult[],
  maxResults: number,
): MemorySearchResult[] {
  // If no core results, return regular results
  if (coreResults.length === 0) return regularResults;

  // Create a set of content hashes to deduplicate
  const seenContent = new Set<string>();
  const merged: MemorySearchResult[] = [];

  // Add high-importance core memory first (importance >= 7)
  for (const result of coreResults) {
    if (result.importance >= 7 && merged.length < maxResults) {
      const contentHash = result.content.slice(0, 100).toLowerCase().replace(/\s+/g, '');
      if (!seenContent.has(contentHash)) {
        merged.push(result);
        seenContent.add(contentHash);
      }
    }
  }

  // Then add regular results
  for (const result of regularResults) {
    if (merged.length >= maxResults) break;
    const contentHash = result.content.slice(0, 100).toLowerCase().replace(/\s+/g, '');
    if (!seenContent.has(contentHash)) {
      merged.push(result);
      seenContent.add(contentHash);
    }
  }

  // Fill remaining slots with lower-importance core memory
  for (const result of coreResults) {
    if (merged.length >= maxResults) break;
    if (result.importance < 7) {
      const contentHash = result.content.slice(0, 100).toLowerCase().replace(/\s+/g, '');
      if (!seenContent.has(contentHash)) {
        merged.push(result);
        seenContent.add(contentHash);
      }
    }
  }

  return merged;
}

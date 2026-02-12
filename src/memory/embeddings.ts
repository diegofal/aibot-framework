import type { Database } from 'bun:sqlite';
import type { OllamaClient } from '../ollama';
import type { Logger } from '../logger';
import { serializeEmbedding, deserializeEmbedding } from './schema';

export interface EmbeddingService {
  getEmbedding(hash: string, text: string): Promise<number[]>;
  embedBatch(items: { hash: string; text: string }[]): Promise<Map<string, number[]>>;
}

export function createEmbeddingService(
  db: Database,
  ollama: OllamaClient,
  model: string,
  concurrency: number,
  logger: Logger,
): EmbeddingService {
  const getCached = db.prepare<{ embedding: Buffer }, [string]>(
    'SELECT embedding FROM embedding_cache WHERE content_hash = ?'
  );

  const insertCache = db.prepare(
    'INSERT OR REPLACE INTO embedding_cache (content_hash, embedding, model, created_at) VALUES (?, ?, ?, datetime(\'now\'))'
  );

  async function getEmbedding(hash: string, text: string): Promise<number[]> {
    // Check cache first
    const cached = getCached.get(hash);
    if (cached) {
      return deserializeEmbedding(cached.embedding);
    }

    // Generate embedding
    const result = await ollama.embed(text, model);
    const embedding = result.embedding;

    // Cache it
    insertCache.run(hash, serializeEmbedding(embedding), model);
    logger.debug({ hash: hash.slice(0, 8) }, 'Embedding cached');

    return embedding;
  }

  async function embedBatch(items: { hash: string; text: string }[]): Promise<Map<string, number[]>> {
    const results = new Map<string, number[]>();
    let running = 0;
    let idx = 0;

    return new Promise((resolve, reject) => {
      if (items.length === 0) {
        resolve(results);
        return;
      }

      function next() {
        while (running < concurrency && idx < items.length) {
          const item = items[idx++];
          running++;
          getEmbedding(item.hash, item.text)
            .then((emb) => {
              results.set(item.hash, emb);
              running--;
              if (results.size === items.length) {
                resolve(results);
              } else {
                next();
              }
            })
            .catch(reject);
        }
      }

      next();
    });
  }

  return { getEmbedding, embedBatch };
}

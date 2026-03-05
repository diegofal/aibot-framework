import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemorySearchConfig } from '../../src/config';
import type { Logger } from '../../src/logger';
import { MemoryManager } from '../../src/memory/manager';
import { initializeMemoryDb } from '../../src/memory/schema';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

/**
 * Integration tests for per-bot memory cleanup.
 * Verifies that clearIndexForBot only removes entries for the target bot
 * and cleans orphaned embedding_cache entries.
 */
describe('MemoryManager per-bot cleanup', () => {
  let db: Database;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `memory-reset-test-${Date.now()}`);
    dbPath = join(tmpDir, 'memory.db');
    mkdirSync(tmpDir, { recursive: true });
    db = initializeMemoryDb(dbPath, noopLogger);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertFile(path: string, sourceType = 'memory'): number {
    db.prepare(
      "INSERT INTO files (path, content_hash, last_indexed_at, chunk_count, source_type) VALUES (?, ?, datetime('now'), 1, ?)"
    ).run(path, `hash_${path}`, sourceType);
    const row = db
      .prepare<{ id: number }, [string]>('SELECT id FROM files WHERE path = ?')
      .get(path);
    return row?.id;
  }

  function insertChunk(fileId: number, content: string, contentHash: string): void {
    db.prepare(
      'INSERT INTO chunks (file_id, chunk_index, content, start_line, end_line, token_estimate, content_hash) VALUES (?, 0, ?, 1, 10, 50, ?)'
    ).run(fileId, content, contentHash);
  }

  function insertEmbeddingCache(contentHash: string): void {
    db.prepare(
      "INSERT INTO embedding_cache (content_hash, embedding, model) VALUES (?, X'00', 'test')"
    ).run(contentHash);
  }

  it('clearIndexForBot removes only entries for the target bot', () => {
    // Insert files for two bots
    const f1 = insertFile('botA/GOALS.md');
    insertChunk(f1, 'Goal content for botA', 'hash_a1');

    const f2 = insertFile('botA/memory/2026-03-01.md');
    insertChunk(f2, 'Memory log for botA', 'hash_a2');

    const f3 = insertFile('botB/GOALS.md');
    insertChunk(f3, 'Goal content for botB', 'hash_b1');

    const manager = createManagerWithDb(db);
    const deleted = manager.clearIndexForBot('botA');

    expect(deleted).toBe(2);

    // botB files should still exist
    const remaining = db.prepare<{ path: string }, []>('SELECT path FROM files').all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].path).toBe('botB/GOALS.md');

    // botB chunks should still exist
    const chunks = db.prepare<{ content: string }, []>('SELECT content FROM chunks').all();
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Goal content for botB');
  });

  it('cleans orphaned embedding_cache entries after clearing bot index', () => {
    // Insert files with shared and unique content hashes
    const f1 = insertFile('botA/SOUL.md');
    insertChunk(f1, 'Unique to botA', 'hash_unique_a');
    insertEmbeddingCache('hash_unique_a');

    const f2 = insertFile('botB/SOUL.md');
    insertChunk(f2, 'Unique to botB', 'hash_unique_b');
    insertEmbeddingCache('hash_unique_b');

    // Shared hash used by both bots
    const f3 = insertFile('botA/IDENTITY.md');
    insertChunk(f3, 'Shared content', 'hash_shared');
    const f4 = insertFile('botB/IDENTITY.md');
    insertChunk(f4, 'Shared content', 'hash_shared');
    insertEmbeddingCache('hash_shared');

    const manager = createManagerWithDb(db);
    manager.clearIndexForBot('botA');

    // hash_unique_a should be removed from cache (orphaned)
    const cacheEntries = db
      .prepare<{ content_hash: string }, []>('SELECT content_hash FROM embedding_cache')
      .all();
    const hashes = cacheEntries.map((e) => e.content_hash);

    expect(hashes).toContain('hash_unique_b');
    expect(hashes).toContain('hash_shared'); // still referenced by botB
    expect(hashes).not.toContain('hash_unique_a'); // orphaned, should be cleaned
  });

  it('clearIndexForBot also clears session transcript entries', () => {
    // Insert soul files for botA
    const f1 = insertFile('botA/GOALS.md');
    insertChunk(f1, 'Goal content for botA', 'hash_a_goal');

    // Insert session transcripts for botA
    const f2 = insertFile('sessions/bot-botA-12345', 'session');
    insertChunk(f2, 'Session transcript for botA', 'hash_a_session');

    const f3 = insertFile('sessions/bot-botA-67890', 'session');
    insertChunk(f3, 'Another session for botA', 'hash_a_session2');

    // Insert session transcripts for botB (should survive)
    const f4 = insertFile('sessions/bot-botB-99999', 'session');
    insertChunk(f4, 'Session for botB', 'hash_b_session');

    const manager = createManagerWithDb(db);
    const deleted = manager.clearIndexForBot('botA');

    // Should delete botA soul file + 2 session transcripts = 3
    expect(deleted).toBe(3);

    // botB session should still exist
    const remaining = db.prepare<{ path: string }, []>('SELECT path FROM files').all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].path).toBe('sessions/bot-botB-99999');
  });

  it('returns 0 when no files match the bot prefix', () => {
    const f1 = insertFile('botB/GOALS.md');
    insertChunk(f1, 'Content', 'hash_1');

    const manager = createManagerWithDb(db);
    const deleted = manager.clearIndexForBot('nonexistent');

    expect(deleted).toBe(0);

    // botB data untouched
    const files = db.prepare<{ c: number }, []>('SELECT COUNT(*) as c FROM files').get();
    expect(files?.c).toBe(1);
  });

  it('clearCoreMemoryForBot clears only entries for the target bot', () => {
    db.prepare(
      "INSERT INTO core_memory (bot_id, category, key, value, importance) VALUES ('botA', 'goals', 'g1', 'val1', 5)"
    ).run();
    db.prepare(
      "INSERT INTO core_memory (bot_id, category, key, value, importance) VALUES ('botA', 'identity', 'i1', 'val2', 8)"
    ).run();
    db.prepare(
      "INSERT INTO core_memory (bot_id, category, key, value, importance) VALUES ('botB', 'goals', 'g2', 'val3', 7)"
    ).run();

    const manager = createManagerWithDb(db);
    const cleared = manager.clearCoreMemoryForBot('botA');

    expect(cleared).toBe(2);
    const remaining = db.prepare<{ c: number }, []>('SELECT COUNT(*) as c FROM core_memory').get();
    expect(remaining?.c).toBe(1);

    // botB entry should still exist
    const botBEntry = db
      .prepare<{ key: string }, [string]>('SELECT key FROM core_memory WHERE bot_id = ?')
      .get('botB');
    expect(botBEntry?.key).toBe('g2');
  });

  it('clearCoreMemoryForBot returns 0 when bot has no entries', () => {
    db.prepare(
      "INSERT INTO core_memory (bot_id, category, key, value, importance) VALUES ('botB', 'goals', 'g1', 'val1', 5)"
    ).run();

    const manager = createManagerWithDb(db);
    const cleared = manager.clearCoreMemoryForBot('botA');

    expect(cleared).toBe(0);
    const remaining = db.prepare<{ c: number }, []>('SELECT COUNT(*) as c FROM core_memory').get();
    expect(remaining?.c).toBe(1);
  });

  function createManagerWithDb(database: Database): MemoryManager {
    const manager = new MemoryManager(
      tmpDir,
      {
        dbPath,
        enabled: true,
        embeddingModel: 'test',
        concurrency: 1,
        chunkTargetTokens: 200,
        chunkOverlapTokens: 50,
        defaultMaxResults: 5,
        defaultMinScore: 0.1,
        vectorWeight: 0.7,
        keywordWeight: 0.3,
        watchEnabled: false,
        syncIntervalMs: 1000,
      },
      {} as any,
      noopLogger
    );
    // Inject the db directly for testing
    (manager as any).db = database;
    return manager;
  }
});

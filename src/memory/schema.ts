import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  content_hash TEXT NOT NULL,
  last_indexed_at TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);

CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, content='chunks', content_rowid='id');

-- Triggers to keep FTS in sync with chunks table
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES (new.id, new.content);
END;

-- Core Memory tables (MemGPT-style structured identity storage)
CREATE TABLE IF NOT EXISTS core_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bot_id, user_id, category, key)
);

CREATE INDEX IF NOT EXISTS idx_core_memory_category ON core_memory(category);
CREATE INDEX IF NOT EXISTS idx_core_memory_importance ON core_memory(importance DESC);
CREATE INDEX IF NOT EXISTS idx_core_memory_updated ON core_memory(updated_at DESC);
`;

/**
 * Run schema migrations on existing databases (idempotent)
 */
function migrateSchema(db: Database, logger: Logger): void {
  // Add source_type column to files table if missing
  const columns = db.prepare('PRAGMA table_info(files)').all() as { name: string }[];
  const hasSourceType = columns.some((c) => c.name === 'source_type');
  if (!hasSourceType) {
    db.exec("ALTER TABLE files ADD COLUMN source_type TEXT NOT NULL DEFAULT 'memory'");
    db.exec('CREATE INDEX IF NOT EXISTS idx_files_source_type ON files(source_type)');
    logger.info('Migration: added source_type column to files table');
  }

  // Add bot_id column to core_memory table if missing (per-bot memory isolation)
  const coreColumns = db.prepare('PRAGMA table_info(core_memory)').all() as { name: string }[];
  const hasBotId = coreColumns.some((c) => c.name === 'bot_id');
  if (!hasBotId && coreColumns.length > 0) {
    // Rebuild table to change UNIQUE constraint from (category, key) to (bot_id, category, key)
    db.exec(`
      CREATE TABLE core_memory_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL DEFAULT 'default',
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 5,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(bot_id, category, key)
      );
      INSERT INTO core_memory_new (id, bot_id, category, key, value, importance, created_at, updated_at)
        SELECT id, 'default', category, key, value, importance, created_at, updated_at FROM core_memory;
      DROP TABLE core_memory;
      ALTER TABLE core_memory_new RENAME TO core_memory;
      CREATE INDEX idx_core_memory_bot_id ON core_memory(bot_id);
      CREATE INDEX idx_core_memory_category ON core_memory(category);
      CREATE INDEX idx_core_memory_importance ON core_memory(importance DESC);
      CREATE INDEX idx_core_memory_updated ON core_memory(updated_at DESC);
    `);
    logger.info('Migration: added bot_id column to core_memory table');
  }

  // Ensure bot_id index exists (runs after migration for existing DBs, and for new DBs
  // where SCHEMA_SQL created the table with bot_id but the index isn't in SCHEMA_SQL)
  db.exec('CREATE INDEX IF NOT EXISTS idx_core_memory_bot_id ON core_memory(bot_id)');

  // Add user_id column to core_memory table if missing (per-user isolation)
  const coreColumnsForUserId = db.prepare('PRAGMA table_info(core_memory)').all() as {
    name: string;
  }[];
  const hasUserId = coreColumnsForUserId.some((c) => c.name === 'user_id');
  if (!hasUserId && coreColumnsForUserId.length > 0) {
    // Rebuild table to add user_id and change UNIQUE constraint
    db.exec(`
      CREATE TABLE core_memory_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL DEFAULT 'default',
        user_id TEXT,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 5,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(bot_id, user_id, category, key)
      );
      INSERT INTO core_memory_new (id, bot_id, user_id, category, key, value, importance, created_at, updated_at)
        SELECT id, bot_id, NULL, category, key, value, importance, created_at, updated_at FROM core_memory;
      DROP TABLE core_memory;
      ALTER TABLE core_memory_new RENAME TO core_memory;
      CREATE INDEX idx_core_memory_bot_id ON core_memory(bot_id);
      CREATE INDEX idx_core_memory_user_id ON core_memory(user_id);
      CREATE INDEX idx_core_memory_category ON core_memory(category);
      CREATE INDEX idx_core_memory_importance ON core_memory(importance DESC);
      CREATE INDEX idx_core_memory_updated ON core_memory(updated_at DESC);
    `);
    logger.info('Migration: added user_id column to core_memory table');
  }

  // Ensure user_id index exists
  db.exec('CREATE INDEX IF NOT EXISTS idx_core_memory_user_id ON core_memory(user_id)');
}

export function initializeMemoryDb(dbPath: string, logger: Logger): Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Execute full schema (bun:sqlite exec handles multiple statements natively)
  db.exec(SCHEMA_SQL);

  // Run migrations for existing databases
  migrateSchema(db, logger);

  logger.info({ dbPath }, 'Memory database initialized');
  return db;
}

export function serializeEmbedding(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

export function deserializeEmbedding(buf: Buffer): number[] {
  const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(float32);
}

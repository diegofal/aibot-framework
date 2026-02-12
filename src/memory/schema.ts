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
`;

export function initializeMemoryDb(dbPath: string, logger: Logger): Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Execute full schema (bun:sqlite exec handles multiple statements natively)
  db.exec(SCHEMA_SQL);

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

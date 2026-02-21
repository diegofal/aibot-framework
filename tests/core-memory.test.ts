import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createCoreMemoryManager, type CoreMemoryManager } from '../src/memory/core-memory';
import type { Logger } from '../src/logger';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

describe('CoreMemoryManager', () => {
  let db: Database;
  let manager: CoreMemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE core_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 5,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(category, key)
      );
      CREATE INDEX idx_core_memory_category ON core_memory(category);
      CREATE INDEX idx_core_memory_importance ON core_memory(importance DESC);
      CREATE INDEX idx_core_memory_updated ON core_memory(updated_at DESC);
    `);
    manager = createCoreMemoryManager(db, noopLogger);
  });

  afterEach(() => {
    db.close();
  });

  describe('set and get', () => {
    test('creates new entry', async () => {
      await manager.set('identity', 'name', 'TestBot', 8);
      const entry = await manager.get('identity', 'name');

      expect(entry).not.toBeNull();
      expect(entry?.category).toBe('identity');
      expect(entry?.key).toBe('name');
      expect(entry?.value).toBe('TestBot');
      expect(entry?.importance).toBe(8);
    });

    test('updates existing entry', async () => {
      await manager.set('identity', 'name', 'TestBot', 8);
      await manager.set('identity', 'name', 'UpdatedBot', 9);
      const entry = await manager.get('identity', 'name');

      expect(entry?.value).toBe('UpdatedBot');
      expect(entry?.importance).toBe(9);
    });

    test('returns null for non-existent entry', async () => {
      const entry = await manager.get('identity', 'nonexistent');
      expect(entry).toBeNull();
    });

    test('rejects invalid category', async () => {
      await expect(
        manager.set('invalid_category', 'key', 'value')
      ).rejects.toThrow(/Invalid category/);
    });

    test('rejects key too long', async () => {
      const longKey = 'a'.repeat(101);
      await expect(
        manager.set('identity', longKey, 'value')
      ).rejects.toThrow(/Key too long/);
    });

    test('rejects value too long', async () => {
      const longValue = 'a'.repeat(2001);
      await expect(
        manager.set('identity', 'key', longValue)
      ).rejects.toThrow(/Value too long/);
    });

    test('rejects invalid importance', async () => {
      await expect(
        manager.set('identity', 'key', 'value', 0)
      ).rejects.toThrow(/Importance must be between/);
      await expect(
        manager.set('identity', 'key', 'value', 11)
      ).rejects.toThrow(/Importance must be between/);
    });
  });

  describe('delete', () => {
    test('deletes existing entry', async () => {
      await manager.set('identity', 'name', 'TestBot');
      const deleted = await manager.delete('identity', 'name');
      expect(deleted).toBe(true);

      const entry = await manager.get('identity', 'name');
      expect(entry).toBeNull();
    });

    test('returns false for non-existent entry', async () => {
      const deleted = await manager.delete('identity', 'nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await manager.set('identity', 'name', 'AutoForja', 10);
      await manager.set('identity', 'style', 'Technical and precise', 7);
      await manager.set('relationships', 'user_diego', 'Works on AI infrastructure', 8);
      await manager.set('preferences', 'communication', 'Concise responses', 6);
    });

    test('searches by key', async () => {
      const results = await manager.search('name');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('name');
    });

    test('searches by value', async () => {
      const results = await manager.search('infrastructure');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('user_diego');
    });

    test('filters by category', async () => {
      const results = await manager.search('technical', 'identity');
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe('identity');
    });

    test('respects limit', async () => {
      const results = await manager.search('a', undefined, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test('orders by importance desc', async () => {
      const results = await manager.search('');
      expect(results[0].importance).toBeGreaterThanOrEqual(results[1]?.importance ?? 0);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await manager.set('identity', 'name', 'AutoForja', 10);
      await manager.set('identity', 'style', 'Technical', 7);
      await manager.set('relationships', 'user_diego', 'Works on AI', 8);
    });

    test('lists all entries', async () => {
      const results = await manager.list();
      expect(results).toHaveLength(3);
    });

    test('filters by category', async () => {
      const results = await manager.list('identity');
      expect(results).toHaveLength(2);
      expect(results.every(r => r.category === 'identity')).toBe(true);
    });

    test('filters by minimum importance', async () => {
      const results = await manager.list(undefined, 8);
      expect(results.every(r => r.importance >= 8)).toBe(true);
    });

    test('combines category and importance filters', async () => {
      const results = await manager.list('identity', 8);
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('name');
    });
  });

  describe('renderForSystemPrompt', () => {
    test('renders empty string when no entries', () => {
      const output = manager.renderForSystemPrompt();
      expect(output).toBe('');
    });

    test('renders entries with importance >= 5', async () => {
      await manager.set('identity', 'name', 'AutoForja', 10);
      await manager.set('identity', 'low', 'Should not appear', 4);

      const output = manager.renderForSystemPrompt();
      expect(output).toContain('AutoForja');
      expect(output).not.toContain('Should not appear');
    });

    test('respects maxChars limit', async () => {
      await manager.set('identity', 'name', 'AutoForja', 10);
      await manager.set('relationships', 'user_test', 'A very long description that takes up space', 9);

      const output = manager.renderForSystemPrompt(100);
      expect(output.length).toBeLessThanOrEqual(100 + 50); // some tolerance for formatting
    });

    test('groups by category', async () => {
      await manager.set('identity', 'name', 'AutoForja', 10);
      await manager.set('relationships', 'user_diego', 'Works on AI', 9);

      const output = manager.renderForSystemPrompt();
      expect(output).toContain('## Core Memory');
      expect(output).toContain('**Identity**');
      expect(output).toContain('**Relationships**');
    });
  });

  describe('valid categories', () => {
    test('accepts all valid categories', async () => {
      const validCategories = ['identity', 'relationships', 'preferences', 'goals', 'constraints'];
      for (const category of validCategories) {
        await manager.set(category, 'test', 'value');
        const entry = await manager.get(category, 'test');
        expect(entry).not.toBeNull();
      }
    });
  });
});

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MemoryFlusher, type ScoredFact } from '../src/bot/memory-flush';
import { createCoreMemoryManager } from '../src/memory/core-memory';
import type { BotContext } from '../src/bot/types';
import type { ChatMessage } from '../src/ollama';
import type { Logger } from '../src/logger';
import type { MemoryManager } from '../src/memory/manager';
import type { SoulLoader } from '../src/soul-loader';
import type { Config } from '../src/config';
import type { OllamaClient } from '../src/ollama';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

// Mock BotContext
function createMockContext(db: Database): BotContext {
  const coreMemory = createCoreMemoryManager(db, noopLogger);
  
  return {
    config: { ollama: { models: { primary: 'test-model' } } } as Config,
    logger: noopLogger,
    ollamaClient: {} as OllamaClient,
    memoryManager: {
      getCoreMemory: () => coreMemory,
    } as unknown as MemoryManager,
    getSoulLoader: () => ({ appendDailyMemory: () => {} }) as unknown as SoulLoader,
    defaultSoulLoader: { appendDailyMemory: () => {} } as unknown as SoulLoader,
    getActiveModel: () => 'test-model',
  } as unknown as BotContext;
}

describe('MemoryFlusher', () => {
  let db: Database;
  let flusher: MemoryFlusher;

  beforeEach(() => {
    db = new Database(':memory:');
    // Initialize core_memory table
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
    `);
    const ctx = createMockContext(db);
    flusher = new MemoryFlusher(ctx);
  });

  afterEach(() => {
    db.close();
  });

  describe('parseScoredFacts', () => {
    test('parses JSON array format', () => {
      const response = JSON.stringify([
        { fact: 'User likes pizza', importance: 8, category: 'preferences' },
        { fact: 'User works in AI', importance: 9, category: 'identity' },
      ]);

      // Access private method via type assertion
      const facts = (flusher as unknown as { parseScoredFacts: (r: string) => ScoredFact[] }).parseScoredFacts(response);

      expect(facts).toHaveLength(2);
      expect(facts[0]).toEqual({ fact: 'User likes pizza', importance: 8, category: 'preferences' });
      expect(facts[1]).toEqual({ fact: 'User works in AI', importance: 9, category: 'identity' });
    });

    test('clamps importance to 1-10 range', () => {
      const response = JSON.stringify([
        { fact: 'Test 1', importance: 15, category: 'general' },
        { fact: 'Test 2', importance: -3, category: 'general' },
      ]);

      const facts = (flusher as unknown as { parseScoredFacts: (r: string) => ScoredFact[] }).parseScoredFacts(response);

      expect(facts[0].importance).toBe(10);
      expect(facts[1].importance).toBe(1);
    });

    test('parses bracket format fallback', () => {
      const response = `
        - [8] User mentioned they like hiking
        - [5] Discussed weather today
        - [9/10] Critical security issue discussed
      `;

      const facts = (flusher as unknown as { parseScoredFacts: (r: string) => ScoredFact[] }).parseScoredFacts(response);

      expect(facts).toHaveLength(3);
      expect(facts[0].importance).toBe(8);
      expect(facts[0].fact).toBe('User mentioned they like hiking');
      expect(facts[1].importance).toBe(5);
      expect(facts[2].importance).toBe(9);
      expect(facts[0].category).toBe('general'); // fallback
    });

    test('returns empty array for invalid input', () => {
      const response = 'This is just random text without any structured data';
      const facts = (flusher as unknown as { parseScoredFacts: (r: string) => ScoredFact[] }).parseScoredFacts(response);
      expect(facts).toHaveLength(0);
    });
  });

  describe('generateFactKey', () => {
    test('generates stable keys from facts', () => {
      const fact: ScoredFact = {
        fact: 'User likes pizza with pepperoni',
        importance: 8,
        category: 'preferences',
      };

      const key = (flusher as unknown as { generateFactKey: (f: ScoredFact) => string }).generateFactKey(fact);

      expect(key).toBe('user_likes_pizza_with_pepperoni');
    });

    test('handles special characters', () => {
      const fact: ScoredFact = {
        fact: 'User\'s favorite color is "blue"!',
        importance: 5,
        category: 'general',
      };

      const key = (flusher as unknown as { generateFactKey: (f: ScoredFact) => string }).generateFactKey(fact);

      expect(key).toBe('users_favorite_color_is_blue');
    });

    test('truncates long facts', () => {
      const fact: ScoredFact = {
        fact: 'a'.repeat(100),
        importance: 5,
        category: 'general',
      };

      const key = (flusher as unknown as { generateFactKey: (f: ScoredFact) => string }).generateFactKey(fact);

      expect(key.length).toBeLessThanOrEqual(50);
    });
  });
});

describe('Importance scoring integration', () => {
  test('high importance facts are prioritized in search', async () => {
    const db = new Database(':memory:');
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
    `);

    const coreMemory = createCoreMemoryManager(db, noopLogger);

    // Insert facts with different importance
    await coreMemory.set('preferences', 'food', 'User likes pizza', 9);
    await coreMemory.set('preferences', 'color', 'User likes blue', 3);
    await coreMemory.set('identity', 'work', 'User works in AI', 8);

    // Search should find the high-importance facts
    const results = await coreMemory.search('user likes');
    
    // Results should be sorted by importance
    expect(results.length).toBeGreaterThan(0);
    if (results.length > 0) {
      expect(results[0].importance).toBeGreaterThanOrEqual(results[results.length - 1].importance);
    }

    db.close();
  });
});

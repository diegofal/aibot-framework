import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeMesh, computeTemporalWeight } from '../src/bot/knowledge-mesh';

const TEST_DIR = join(import.meta.dir, '.tmp-knowledge-mesh');
const MESH_FILE = join(TEST_DIR, 'mesh.jsonl');

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
} as any;

describe('knowledge-mesh', () => {
  let mesh: KnowledgeMesh;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mesh = new KnowledgeMesh(MESH_FILE, nullLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── Publish ──

  describe('publish', () => {
    it('publishes and persists an entry', () => {
      const entry = mesh.publish('bot-a', 'research', 'Web search works better for current events');
      expect(entry).not.toBeNull();
      expect(entry?.topic).toBe('research');
      expect(entry?.confidence).toBe(0.5);
      expect(mesh.getEntryCount()).toBe(1);
    });

    it('deduplicates entries from same bot with same topic+insight', () => {
      mesh.publish('bot-a', 'research', 'Same insight');
      const dup = mesh.publish('bot-a', 'research', 'Same insight again but longer');
      expect(dup).toBeNull();
      expect(mesh.getEntryCount()).toBe(1);
    });

    it('allows same topic from different bots', () => {
      mesh.publish('bot-a', 'research', 'Insight A');
      mesh.publish('bot-b', 'research', 'Insight B');
      expect(mesh.getEntryCount()).toBe(2);
    });

    it('clamps confidence to [0, 1]', () => {
      const e1 = mesh.publish('bot-a', 'test', 'High', 5.0);
      const e2 = mesh.publish('bot-b', 'test', 'Low', -1.0);
      expect(e1?.confidence).toBe(1.0);
      expect(e2?.confidence).toBe(0);
    });

    it('truncates long fields', () => {
      const entry = mesh.publish('bot-a', 'x'.repeat(200), 'y'.repeat(600), 0.5, 'z'.repeat(300));
      expect(entry?.topic.length).toBe(100);
      expect(entry?.insight.length).toBe(500);
      expect(entry?.evidence?.length).toBe(200);
    });
  });

  // ── Validate / Contradict ──

  describe('validate', () => {
    it('increases confidence when validated', () => {
      const entry = mesh.publish('bot-a', 'topic', 'Insight')!;
      mesh.validate(entry.id, 'bot-b');

      const all = mesh.getAll();
      expect(all[0].confidence).toBeCloseTo(0.6, 1);
      expect(all[0].validatedBy).toContain('bot-b');
    });

    it('does not double-validate from same bot', () => {
      const entry = mesh.publish('bot-a', 'topic', 'Insight')!;
      mesh.validate(entry.id, 'bot-b');
      mesh.validate(entry.id, 'bot-b');

      const all = mesh.getAll();
      expect(all[0].validatedBy).toHaveLength(1);
      expect(all[0].confidence).toBeCloseTo(0.6, 1);
    });
  });

  describe('contradict', () => {
    it('decreases confidence when contradicted', () => {
      const entry = mesh.publish('bot-a', 'topic', 'Insight')!;
      mesh.contradict(entry.id, 'bot-b');

      const all = mesh.getAll();
      expect(all[0].confidence).toBeCloseTo(0.35, 1);
      expect(all[0].contradictedBy).toContain('bot-b');
    });
  });

  // ── Query ──

  describe('query', () => {
    it('finds entries by topic keyword', () => {
      mesh.publish('bot-a', 'research strategies', 'Use web_search for news');
      mesh.publish('bot-b', 'communication tips', 'Keep messages concise');

      const results = mesh.query('research');
      expect(results.length).toBe(1);
      expect(results[0].entry.topic).toContain('research');
    });

    it('excludes entries from querying bot', () => {
      mesh.publish('bot-a', 'research', 'My own insight');
      mesh.publish('bot-b', 'research', 'Peer insight');

      const results = mesh.query('research', { excludeBotId: 'bot-a' });
      expect(results.length).toBe(1);
      expect(results[0].entry.sourceBotId).toBe('bot-b');
    });

    it('filters by minimum confidence', () => {
      const entry = mesh.publish('bot-a', 'research', 'Low confidence')!;
      // Contradict multiple times to lower confidence
      mesh.contradict(entry.id, 'bot-b');
      mesh.contradict(entry.id, 'bot-c');
      mesh.contradict(entry.id, 'bot-d');

      const results = mesh.query('research', { minConfidence: 0.3 });
      expect(results.length).toBe(0);
    });

    it('sorts by relevance score', () => {
      mesh.publish('bot-a', 'research methods', 'Use search engines for research');
      mesh.publish('bot-b', 'cooking recipes', 'Research new flavors');

      const results = mesh.query('research methods');
      expect(results.length).toBeGreaterThan(0);
      // First result should be more relevant (more keyword matches)
      if (results.length >= 2) {
        expect(results[0].relevanceScore).toBeGreaterThanOrEqual(results[1].relevanceScore);
      }
    });

    it('returns empty for no matches', () => {
      mesh.publish('bot-a', 'research', 'Insight');
      const results = mesh.query('cooking');
      expect(results.length).toBe(0);
    });
  });

  // ── Temporal decay ──

  describe('computeTemporalWeight', () => {
    it('returns 1.0 for current timestamp', () => {
      const now = Date.now();
      expect(computeTemporalWeight(now, now, 14)).toBeCloseTo(1.0, 5);
    });

    it('returns ~0.5 at half-life', () => {
      const now = Date.now();
      const halfLifeMs = 14 * 24 * 3_600_000;
      expect(computeTemporalWeight(now - halfLifeMs, now, 14)).toBeCloseTo(0.5, 1);
    });

    it('decays toward zero', () => {
      const now = Date.now();
      const threeHalfLives = 42 * 24 * 3_600_000;
      const weight = computeTemporalWeight(now - threeHalfLives, now, 14);
      expect(weight).toBeLessThan(0.15);
    });
  });

  // ── Sweep ──

  describe('sweep', () => {
    it('removes old low-confidence entries', () => {
      mesh.publish('bot-a', 'old topic', 'Old insight');
      // Backdate and lower confidence
      const all = mesh.getAll();
      all[0].timestamp = Date.now() - 60 * 24 * 3_600_000; // 60 days ago
      all[0].confidence = 0.2;
      const { writeFileSync } = require('node:fs');
      writeFileSync(MESH_FILE, `${all.map((e) => JSON.stringify(e)).join('\n')}\n`);

      const pruned = mesh.sweep();
      expect(pruned).toBe(1);
      expect(mesh.getEntryCount()).toBe(0);
    });

    it('keeps recent high-confidence entries', () => {
      mesh.publish('bot-a', 'fresh', 'Fresh insight');
      const pruned = mesh.sweep();
      expect(pruned).toBe(0);
      expect(mesh.getEntryCount()).toBe(1);
    });
  });

  // ── getRelevantInsights ──

  describe('getRelevantInsights', () => {
    it('returns formatted peer insights', () => {
      mesh.publish('bot-a', 'TypeScript patterns', 'Use strict mode always');
      mesh.publish('bot-b', 'research workflow', 'Break research into 3 phases');

      const result = mesh.getRelevantInsights('bot-c', 'Research TypeScript best practices');
      expect(result).not.toBeNull();
      expect(result).toContain('## Peer Insights');
    });

    it('excludes own insights', () => {
      mesh.publish('bot-a', 'topic', 'My own insight');
      const result = mesh.getRelevantInsights('bot-a', 'topic keywords here');
      expect(result).toBeNull();
    });

    it('returns null when no relevant insights', () => {
      const result = mesh.getRelevantInsights('bot-a', 'completely unrelated');
      expect(result).toBeNull();
    });

    it('respects character budget', () => {
      for (let i = 0; i < 20; i++) {
        mesh.publish(
          `bot-${i}`,
          'research',
          `Insight number ${i} with some extra text to fill space`
        );
      }
      const result = mesh.getRelevantInsights('bot-x', 'research methodology', 300);
      expect(result).not.toBeNull();
      expect(result?.length).toBeLessThanOrEqual(350); // some slack
    });
  });
});

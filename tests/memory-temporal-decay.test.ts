import { describe, expect, it } from 'bun:test';
import {
  applyMMRToMemoryResults,
  computeMMRScore,
  jaccardSimilarity,
  tokenize,
} from '../src/memory/mmr';
import { computeTemporalDecay } from '../src/memory/search';
import type { MemorySearchResult } from '../src/memory/types';

// ---------------------------------------------------------------------------
// Temporal Decay
// ---------------------------------------------------------------------------
describe('computeTemporalDecay', () => {
  const now = new Date('2026-03-15T12:00:00Z');

  it('returns 1 for a just-indexed item (age = 0)', () => {
    const result = computeTemporalDecay('2026-03-15T12:00:00Z', 30, 0.3, now);
    expect(result).toBeCloseTo(1, 5);
  });

  it('returns ~(1 - weight/2) at exactly one half-life', () => {
    // At halfLife days the decay factor = 0.5, so multiplier = 0.7 + 0.3*0.5 = 0.85
    const result = computeTemporalDecay('2026-02-13T12:00:00Z', 30, 0.3, now);
    expect(result).toBeCloseTo(0.85, 2);
  });

  it('approaches (1 - weight) floor for very old items', () => {
    // 1000 days old with halfLife=30 → decay ≈ 0 → multiplier ≈ 0.7
    const veryOld = new Date(now.getTime() - 1000 * 24 * 60 * 60 * 1000).toISOString();
    const result = computeTemporalDecay(veryOld, 30, 0.3, now);
    expect(result).toBeCloseTo(0.7, 2);
  });

  it('recent items score higher than old items', () => {
    const recent = computeTemporalDecay('2026-03-14T12:00:00Z', 30, 0.3, now); // 1 day old
    const old = computeTemporalDecay('2026-01-15T12:00:00Z', 30, 0.3, now); // ~59 days old
    expect(recent).toBeGreaterThan(old);
  });

  it('respects weight parameter — weight=0 means no decay effect', () => {
    const veryOld = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = computeTemporalDecay(veryOld, 30, 0, now);
    expect(result).toBeCloseTo(1, 5);
  });

  it('respects weight parameter — weight=1 means full decay', () => {
    // At one half-life, weight=1 → multiplier = 0 + 1*0.5 = 0.5
    const result = computeTemporalDecay('2026-02-13T12:00:00Z', 30, 1.0, now);
    expect(result).toBeCloseTo(0.5, 2);
  });

  it('handles future timestamps gracefully (returns 1)', () => {
    const result = computeTemporalDecay('2026-03-20T12:00:00Z', 30, 0.3, now);
    expect(result).toBe(1);
  });

  it('larger halfLifeDays means slower decay', () => {
    const thirtyDayOld = '2026-02-13T12:00:00Z';
    const fast = computeTemporalDecay(thirtyDayOld, 30, 0.3, now); // at half-life
    const slow = computeTemporalDecay(thirtyDayOld, 90, 0.3, now); // way before half-life
    expect(slow).toBeGreaterThan(fast);
  });

  it('applies correct exponential curve at various ages', () => {
    const halfLife = 30;
    const weight = 0.3;

    // At 0 half-lives: factor = 1.0
    const at0 = computeTemporalDecay(now.toISOString(), halfLife, weight, now);
    expect(at0).toBeCloseTo(1.0, 3);

    // At 2 half-lives (60 days): factor = 0.25 → 0.7 + 0.3*0.25 = 0.775
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const at2 = computeTemporalDecay(sixtyDaysAgo, halfLife, weight, now);
    expect(at2).toBeCloseTo(0.775, 2);

    // At 3 half-lives (90 days): factor = 0.125 → 0.7 + 0.3*0.125 = 0.7375
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const at3 = computeTemporalDecay(ninetyDaysAgo, halfLife, weight, now);
    expect(at3).toBeCloseTo(0.7375, 2);
  });
});

// ---------------------------------------------------------------------------
// MMR (Maximal Marginal Relevance) — diversity re-ranking
// ---------------------------------------------------------------------------
describe('MMR diversity re-ranking', () => {
  const makeResult = (
    content: string,
    score: number,
    filePath = 'test.md'
  ): MemorySearchResult => ({
    filePath,
    startLine: 1,
    endLine: 1,
    content,
    score,
    source: 'keyword',
    sourceType: 'memory',
  });

  it('returns empty array for empty input', () => {
    expect(applyMMRToMemoryResults([], { enabled: true, lambda: 0.7 })).toEqual([]);
  });

  it('returns same results when disabled', () => {
    const results = [
      makeResult('alpha beta gamma', 0.9),
      makeResult('alpha beta gamma delta', 0.5),
    ];
    const reranked = applyMMRToMemoryResults(results, { enabled: false, lambda: 0.7 });
    expect(reranked).toEqual(results);
  });

  it('selects diverse results over redundant ones', () => {
    // Two similar results and one different one
    const results = [
      makeResult('machine learning neural networks deep learning', 0.9),
      makeResult('machine learning neural networks training data', 0.85),
      makeResult('cooking recipes italian pasta carbonara', 0.8),
    ];

    const reranked = applyMMRToMemoryResults(results, { enabled: true, lambda: 0.5 });

    // First should still be the highest scoring
    expect(reranked[0].content).toContain('deep learning');
    // Second should be the diverse one (cooking), not the similar ML one
    expect(reranked[1].content).toContain('cooking');
  });

  it('with lambda=1 preserves pure relevance ordering', () => {
    const results = [makeResult('alpha', 0.9), makeResult('beta', 0.8), makeResult('gamma', 0.7)];

    const reranked = applyMMRToMemoryResults(results, { enabled: true, lambda: 1.0 });
    expect(reranked[0].score).toBe(0.9);
    expect(reranked[1].score).toBe(0.8);
    expect(reranked[2].score).toBe(0.7);
  });

  it('with lambda=0 maximizes diversity', () => {
    const results = [
      makeResult('aaa bbb ccc', 0.9),
      makeResult('aaa bbb ccc ddd', 0.85), // very similar to first
      makeResult('xxx yyy zzz', 0.5), // totally different
    ];

    const reranked = applyMMRToMemoryResults(results, { enabled: true, lambda: 0.0 });
    // After selecting first item, the diverse one should come next
    expect(reranked[1].content).toContain('xxx');
  });
});

describe('MMR primitives', () => {
  it('tokenize extracts lowercase alphanumeric tokens', () => {
    const tokens = tokenize('Hello World! 123 foo_bar');
    expect(tokens.has('hello')).toBe(true);
    expect(tokens.has('world')).toBe(true);
    expect(tokens.has('123')).toBe(true);
    expect(tokens.has('foo_bar')).toBe(true);
  });

  it('jaccardSimilarity returns 1 for identical sets', () => {
    const s = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it('jaccardSimilarity returns 0 for disjoint sets', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['c', 'd']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('jaccardSimilarity computes correct overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection=2, union=4 → 0.5
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5, 5);
  });

  it('computeMMRScore balances relevance and similarity', () => {
    // lambda=0.7, relevance=0.9, maxSim=0.8
    // MMR = 0.7*0.9 - 0.3*0.8 = 0.63 - 0.24 = 0.39
    expect(computeMMRScore(0.9, 0.8, 0.7)).toBeCloseTo(0.39, 5);
  });
});

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------
describe('TemporalDecayConfigSchema', () => {
  it('has correct defaults', async () => {
    const { TemporalDecayConfigSchema } = await import('../src/config');
    const parsed = TemporalDecayConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.halfLifeDays).toBe(30);
    expect(parsed.weight).toBe(0.3);
  });

  it('accepts custom values', async () => {
    const { TemporalDecayConfigSchema } = await import('../src/config');
    const parsed = TemporalDecayConfigSchema.parse({
      enabled: false,
      halfLifeDays: 60,
      weight: 0.5,
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.halfLifeDays).toBe(60);
    expect(parsed.weight).toBe(0.5);
  });

  it('rejects out-of-range values', async () => {
    const { TemporalDecayConfigSchema } = await import('../src/config');
    expect(() => TemporalDecayConfigSchema.parse({ halfLifeDays: 0 })).toThrow();
    expect(() => TemporalDecayConfigSchema.parse({ halfLifeDays: 400 })).toThrow();
    expect(() => TemporalDecayConfigSchema.parse({ weight: -0.1 })).toThrow();
    expect(() => TemporalDecayConfigSchema.parse({ weight: 1.5 })).toThrow();
  });
});

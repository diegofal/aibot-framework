import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MMR_CONFIG,
  type MMRItem,
  applyMMRToMemoryResults,
  computeMMRScore,
  jaccardSimilarity,
  mmrRerank,
  textSimilarity,
  tokenize,
} from '../src/memory/mmr';
import type { MemorySearchResult } from '../src/memory/types';

describe('tokenize', () => {
  test('normalizes, filters, and deduplicates token sets', () => {
    const cases = [
      {
        name: 'alphanumeric lowercase',
        input: 'Hello World 123',
        expected: ['hello', 'world', '123'],
      },
      { name: 'empty string', input: '', expected: [] },
      { name: 'special chars only', input: '!@#$%^&*()', expected: [] },
      {
        name: 'underscores',
        input: 'hello_world test_case',
        expected: ['hello_world', 'test_case'],
      },
      {
        name: 'dedupe repeated tokens',
        input: 'hello hello world world',
        expected: ['hello', 'world'],
      },
    ] as const;

    for (const testCase of cases) {
      expect(tokenize(testCase.input)).toEqual(new Set(testCase.expected));
    }
  });
});

describe('jaccardSimilarity', () => {
  test('computes expected scores for overlap edge cases', () => {
    const cases = [
      {
        name: 'identical sets',
        left: new Set(['a', 'b', 'c']),
        right: new Set(['a', 'b', 'c']),
        expected: 1,
      },
      { name: 'disjoint sets', left: new Set(['a', 'b']), right: new Set(['c', 'd']), expected: 0 },
      { name: 'two empty sets', left: new Set<string>(), right: new Set<string>(), expected: 1 },
      {
        name: 'left non-empty right empty',
        left: new Set(['a']),
        right: new Set<string>(),
        expected: 0,
      },
      {
        name: 'left empty right non-empty',
        left: new Set<string>(),
        right: new Set(['a']),
        expected: 0,
      },
      {
        name: 'partial overlap',
        left: new Set(['a', 'b', 'c']),
        right: new Set(['b', 'c', 'd']),
        expected: 0.5,
      },
    ] as const;

    for (const testCase of cases) {
      expect(jaccardSimilarity(testCase.left, testCase.right)).toBe(testCase.expected);
    }
  });

  test('is symmetric', () => {
    const setA = new Set(['a', 'b']);
    const setB = new Set(['b', 'c']);
    expect(jaccardSimilarity(setA, setB)).toBe(jaccardSimilarity(setB, setA));
  });
});

describe('textSimilarity', () => {
  test('computes expected text-level similarity cases', () => {
    const cases = [
      { name: 'identical', left: 'hello world', right: 'hello world', expected: 1 },
      { name: 'same words reordered', left: 'hello world', right: 'world hello', expected: 1 },
      { name: 'different text', left: 'hello world', right: 'foo bar', expected: 0 },
      { name: 'case insensitive', left: 'Hello World', right: 'hello world', expected: 1 },
    ] as const;

    for (const testCase of cases) {
      expect(textSimilarity(testCase.left, testCase.right)).toBe(testCase.expected);
    }
  });
});

describe('computeMMRScore', () => {
  test('balances relevance and diversity across lambda settings', () => {
    const cases = [
      {
        name: 'lambda=1 relevance only',
        relevance: 0.8,
        similarity: 0.5,
        lambda: 1,
        expected: 0.8,
      },
      {
        name: 'lambda=0 diversity only',
        relevance: 0.8,
        similarity: 0.5,
        lambda: 0,
        expected: -0.5,
      },
      { name: 'lambda=0.5 mixed', relevance: 0.8, similarity: 0.6, lambda: 0.5, expected: 0.1 },
      { name: 'default lambda math', relevance: 1.0, similarity: 0.5, lambda: 0.7, expected: 0.55 },
    ] as const;

    for (const testCase of cases) {
      expect(computeMMRScore(testCase.relevance, testCase.similarity, testCase.lambda)).toBeCloseTo(
        testCase.expected
      );
    }
  });
});

describe('empty input behavior', () => {
  test('returns empty array for empty input', () => {
    expect(mmrRerank([])).toEqual([]);
    expect(applyMMRToMemoryResults([])).toEqual([]);
  });
});

describe('mmrRerank', () => {
  describe('edge cases', () => {
    test('returns single item unchanged', () => {
      const items: MMRItem[] = [{ id: '1', score: 0.9, content: 'hello' }];
      expect(mmrRerank(items)).toEqual(items);
    });

    test('returns copy, not original array', () => {
      const items: MMRItem[] = [{ id: '1', score: 0.9, content: 'hello' }];
      const result = mmrRerank(items);
      expect(result).not.toBe(items);
    });

    test('returns items unchanged when disabled', () => {
      const items: MMRItem[] = [
        { id: '1', score: 0.9, content: 'hello' },
        { id: '2', score: 0.8, content: 'hello' },
      ];
      const result = mmrRerank(items, { enabled: false });
      expect(result).toEqual(items);
    });
  });

  describe('lambda edge cases', () => {
    const diverseItems: MMRItem[] = [
      { id: '1', score: 1.0, content: 'apple banana cherry' },
      { id: '2', score: 0.9, content: 'apple banana date' },
      { id: '3', score: 0.8, content: 'elderberry fig grape' },
    ];

    test('lambda=1 returns pure relevance order', () => {
      const result = mmrRerank(diverseItems, { lambda: 1 });
      expect(result.map((i) => i.id)).toEqual(['1', '2', '3']);
    });

    test('lambda=0 maximizes diversity', () => {
      const result = mmrRerank(diverseItems, { enabled: true, lambda: 0 });
      // First item is still highest score (no penalty yet)
      expect(result[0].id).toBe('1');
      // Second should be most different from first
      expect(result[1].id).toBe('3'); // elderberry... is most different
    });

    test('clamps lambda > 1 to 1', () => {
      const result = mmrRerank(diverseItems, { lambda: 1.5 });
      expect(result.map((i) => i.id)).toEqual(['1', '2', '3']);
    });

    test('clamps lambda < 0 to 0', () => {
      const result = mmrRerank(diverseItems, { enabled: true, lambda: -0.5 });
      expect(result[0].id).toBe('1');
      expect(result[1].id).toBe('3');
    });
  });

  describe('diversity behavior', () => {
    test('promotes diverse results over similar high-scoring ones', () => {
      const items: MMRItem[] = [
        { id: '1', score: 1.0, content: 'machine learning neural networks' },
        { id: '2', score: 0.95, content: 'machine learning deep learning' },
        { id: '3', score: 0.9, content: 'database systems sql queries' },
        { id: '4', score: 0.85, content: 'machine learning algorithms' },
      ];

      const result = mmrRerank(items, { enabled: true, lambda: 0.5 });

      // First is always highest score
      expect(result[0].id).toBe('1');
      // Second should be the diverse database item, not another ML item
      expect(result[1].id).toBe('3');
    });

    test('handles items with identical content', () => {
      const items: MMRItem[] = [
        { id: '1', score: 1.0, content: 'identical content' },
        { id: '2', score: 0.9, content: 'identical content' },
        { id: '3', score: 0.8, content: 'different stuff' },
      ];

      const result = mmrRerank(items, { enabled: true, lambda: 0.5 });
      expect(result[0].id).toBe('1');
      // Second should be different, not identical duplicate
      expect(result[1].id).toBe('3');
    });

    test('handles all identical content gracefully', () => {
      const items: MMRItem[] = [
        { id: '1', score: 1.0, content: 'same' },
        { id: '2', score: 0.9, content: 'same' },
        { id: '3', score: 0.8, content: 'same' },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      // Should still complete without error, order by score as tiebreaker
      expect(result).toHaveLength(3);
    });
  });

  describe('tie-breaking', () => {
    test('uses original score as tiebreaker', () => {
      const items: MMRItem[] = [
        { id: '1', score: 1.0, content: 'unique content one' },
        { id: '2', score: 0.9, content: 'unique content two' },
        { id: '3', score: 0.8, content: 'unique content three' },
      ];

      // With very different content and lambda=1, should be pure score order
      const result = mmrRerank(items, { lambda: 1 });
      expect(result.map((i) => i.id)).toEqual(['1', '2', '3']);
    });

    test('preserves all items even with same MMR scores', () => {
      const items: MMRItem[] = [
        { id: '1', score: 0.5, content: 'a' },
        { id: '2', score: 0.5, content: 'b' },
        { id: '3', score: 0.5, content: 'c' },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(3);
      expect(new Set(result.map((i) => i.id))).toEqual(new Set(['1', '2', '3']));
    });
  });

  describe('score normalization', () => {
    test('handles items with same scores', () => {
      const items: MMRItem[] = [
        { id: '1', score: 0.5, content: 'hello world' },
        { id: '2', score: 0.5, content: 'foo bar' },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(2);
    });

    test('handles negative scores', () => {
      const items: MMRItem[] = [
        { id: '1', score: -0.5, content: 'hello world' },
        { id: '2', score: -1.0, content: 'foo bar' },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(2);
      // Higher score (less negative) should come first
      expect(result[0].id).toBe('1');
    });
  });
});

describe('applyMMRToMemoryResults', () => {
  function makeResult(
    overrides: Partial<MemorySearchResult> & { filePath: string }
  ): MemorySearchResult {
    return {
      startLine: 1,
      endLine: 10,
      content: 'test content',
      score: 0.5,
      source: 'vector',
      sourceType: 'memory',
      ...overrides,
    };
  }

  test('preserves all original fields', () => {
    const results: MemorySearchResult[] = [
      makeResult({
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 10,
        score: 0.9,
        content: 'hello world',
        source: 'both',
        sourceType: 'session',
      }),
    ];

    const reranked = applyMMRToMemoryResults(results);
    expect(reranked[0]).toEqual(results[0]);
  });

  test('creates unique IDs from filePath and startLine', () => {
    const results: MemorySearchResult[] = [
      makeResult({
        filePath: '/test/a.ts',
        startLine: 1,
        endLine: 10,
        score: 0.9,
        content: 'same content here',
      }),
      makeResult({
        filePath: '/test/a.ts',
        startLine: 20,
        endLine: 30,
        score: 0.8,
        content: 'same content here',
      }),
    ];

    // Should work without ID collision
    const reranked = applyMMRToMemoryResults(results);
    expect(reranked).toHaveLength(2);
  });

  test('re-ranks results for diversity', () => {
    const results: MemorySearchResult[] = [
      makeResult({
        filePath: '/a.ts',
        startLine: 1,
        score: 1.0,
        content: 'function add numbers together',
      }),
      makeResult({
        filePath: '/b.ts',
        startLine: 1,
        score: 0.95,
        content: 'function add values together',
      }),
      makeResult({
        filePath: '/c.ts',
        startLine: 1,
        score: 0.9,
        content: 'database connection pool',
      }),
    ];

    const reranked = applyMMRToMemoryResults(results, { enabled: true, lambda: 0.5 });

    // First stays the same (highest score)
    expect(reranked[0].filePath).toBe('/a.ts');
    // Second should be the diverse one
    expect(reranked[1].filePath).toBe('/c.ts');
  });

  test('respects disabled config', () => {
    const results: MemorySearchResult[] = [
      makeResult({ filePath: '/a.ts', score: 0.9, content: 'test' }),
      makeResult({ filePath: '/b.ts', score: 0.8, content: 'test' }),
    ];

    const reranked = applyMMRToMemoryResults(results, { enabled: false });
    expect(reranked).toEqual(results);
  });
});

describe('DEFAULT_MMR_CONFIG', () => {
  test('has expected default values', () => {
    expect(DEFAULT_MMR_CONFIG.enabled).toBe(false);
    expect(DEFAULT_MMR_CONFIG.lambda).toBe(0.7);
  });
});

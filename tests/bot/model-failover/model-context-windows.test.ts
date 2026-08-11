import { describe, expect, test } from 'bun:test';
import {
  MODEL_CONTEXT_WINDOWS,
  resolveChainContextWindow,
  resolveModelContextWindow,
} from '../../../src/bot/model-failover/model-context-windows';

describe('resolveModelContextWindow', () => {
  test('reads the built-in table', () => {
    expect(resolveModelContextWindow('gpt-oss:120b-cloud')).toBe(128_000);
    expect(resolveModelContextWindow('nemotron-3-super:cloud')).toBe(256_000);
  });

  test('returns undefined for an unknown tag', () => {
    expect(resolveModelContextWindow('some-model-nobody-listed:cloud')).toBeUndefined();
  });

  test('operator overrides win over the built-in table', () => {
    expect(resolveModelContextWindow('gpt-oss:120b-cloud', { 'gpt-oss:120b-cloud': 64_000 })).toBe(
      64_000
    );
  });

  test('overrides can supply a tag the table does not know', () => {
    expect(resolveModelContextWindow('brand-new:cloud', { 'brand-new:cloud': 42_000 })).toBe(
      42_000
    );
  });

  test('ignores blank input and non-positive overrides', () => {
    expect(resolveModelContextWindow('')).toBeUndefined();
    expect(resolveModelContextWindow('   ')).toBeUndefined();
    expect(resolveModelContextWindow('gpt-oss:120b-cloud', { 'gpt-oss:120b-cloud': 0 })).toBe(
      128_000
    );
  });
});

describe('resolveChainContextWindow', () => {
  test('picks the smallest window in the chain, not the primary', () => {
    const result = resolveChainContextWindow([
      'kimi-k2.6:cloud', // 256K primary
      'gpt-oss:120b-cloud', // 128K
      'nemotron-3-super:cloud', // 256K
    ]);
    expect(result.tokens).toBe(128_000);
    expect(result.limitingModel).toBe('gpt-oss:120b-cloud');
    expect(result.unknownModels).toEqual([]);
  });

  test('order within the chain does not change the minimum', () => {
    const a = resolveChainContextWindow(['kimi-k2.6:cloud', 'gpt-oss:120b-cloud']);
    const b = resolveChainContextWindow(['gpt-oss:120b-cloud', 'kimi-k2.6:cloud']);
    expect(a.tokens).toBe(b.tokens);
  });

  test('adding a smaller model tightens the budget automatically', () => {
    const before = resolveChainContextWindow(['kimi-k2.6:cloud', 'gpt-oss:120b-cloud']);
    const after = resolveChainContextWindow([
      'kimi-k2.6:cloud',
      'gpt-oss:120b-cloud',
      'qwen2.5-coder:32b',
    ]);
    expect(before.tokens).toBe(128_000);
    expect(after.tokens).toBe(32_768);
    expect(after.limitingModel).toBe('qwen2.5-coder:32b');
  });

  test('unknown tags are reported but impose no constraint', () => {
    const result = resolveChainContextWindow(['kimi-k2.6:cloud', 'mystery-model:cloud']);
    expect(result.tokens).toBe(256_000);
    expect(result.unknownModels).toEqual(['mystery-model:cloud']);
  });

  test('an entirely unknown chain yields no minimum at all', () => {
    const result = resolveChainContextWindow(['mystery-a', 'mystery-b']);
    expect(result.tokens).toBeUndefined();
    expect(result.limitingModel).toBeUndefined();
    expect(result.unknownModels).toEqual(['mystery-a', 'mystery-b']);
  });

  test('skips blank and undefined entries', () => {
    const result = resolveChainContextWindow([undefined, '', '  ', 'gpt-oss:120b-cloud']);
    expect(result.tokens).toBe(128_000);
    expect(result.unknownModels).toEqual([]);
  });

  test('deduplicates repeated unknown tags', () => {
    const result = resolveChainContextWindow(['mystery', 'mystery']);
    expect(result.unknownModels).toEqual(['mystery']);
  });

  test('empty chain yields no constraint', () => {
    expect(resolveChainContextWindow([]).tokens).toBeUndefined();
  });

  test('overrides feed through to the chain minimum', () => {
    const result = resolveChainContextWindow(['kimi-k2.6:cloud', 'mystery-model:cloud'], {
      'mystery-model:cloud': 16_000,
    });
    expect(result.tokens).toBe(16_000);
    expect(result.limitingModel).toBe('mystery-model:cloud');
    expect(result.unknownModels).toEqual([]);
  });
});

describe('MODEL_CONTEXT_WINDOWS table', () => {
  test('covers the shipped default chain', () => {
    for (const tag of ['kimi-k2.6:cloud', 'gpt-oss:120b-cloud', 'nemotron-3-super:cloud']) {
      expect(MODEL_CONTEXT_WINDOWS[tag]).toBeGreaterThan(0);
    }
  });

  test('is frozen so callers cannot mutate shared state', () => {
    expect(Object.isFrozen(MODEL_CONTEXT_WINDOWS)).toBe(true);
  });
});

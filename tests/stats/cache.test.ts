import { describe, expect, it } from 'bun:test';
import { TtlCache } from '../../src/stats/cache';

describe('TtlCache', () => {
  it('computes once within the ttl and recomputes after expiry', () => {
    let now = 1000;
    const cache = new TtlCache(() => now);
    let calls = 0;
    const compute = () => ++calls;
    expect(cache.get('k', 60_000, compute)).toBe(1);
    now += 30_000;
    expect(cache.get('k', 60_000, compute)).toBe(1);
    now += 31_000;
    expect(cache.get('k', 60_000, compute)).toBe(2);
  });
  it('keys are independent and invalidate() clears everything', () => {
    const cache = new TtlCache(() => 0);
    expect(cache.get('a', 1000, () => 'A')).toBe('A');
    expect(cache.get('b', 1000, () => 'B')).toBe('B');
    cache.invalidate();
    expect(cache.get('a', 1000, () => 'A2')).toBe('A2');
  });
});

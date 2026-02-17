import { describe, test, expect, beforeEach } from 'bun:test';
import { TtlCache } from '../src/tools/cache';

describe('TtlCache', () => {
  let cache: TtlCache<string>;

  beforeEach(() => {
    cache = new TtlCache<string>(100); // 100ms TTL for fast tests
  });

  test('returns undefined for missing keys', () => {
    expect(cache.get('nope')).toBeUndefined();
  });

  test('stores and retrieves values', () => {
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');
  });

  test('overwrites existing values', () => {
    cache.set('key', 'v1');
    cache.set('key', 'v2');
    expect(cache.get('key')).toBe('v2');
  });

  test('expires entries after TTL', async () => {
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');

    await Bun.sleep(150);

    expect(cache.get('key')).toBeUndefined();
  });

  test('does not expire entries before TTL', async () => {
    cache.set('key', 'value');
    await Bun.sleep(50);
    expect(cache.get('key')).toBe('value');
  });

  test('prune() removes all expired entries', async () => {
    cache.set('a', '1');
    cache.set('b', '2');

    await Bun.sleep(150);

    cache.set('c', '3'); // fresh

    cache.prune();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('3');
  });

  test('uses default TTL of 15 minutes when not specified', () => {
    const defaultCache = new TtlCache<string>();
    defaultCache.set('key', 'value');
    // Should still be alive immediately
    expect(defaultCache.get('key')).toBe('value');
  });

  test('handles different value types', () => {
    const numCache = new TtlCache<number>(1000);
    numCache.set('count', 42);
    expect(numCache.get('count')).toBe(42);

    const objCache = new TtlCache<{ x: number }>(1000);
    objCache.set('point', { x: 10 });
    expect(objCache.get('point')).toEqual({ x: 10 });
  });
});

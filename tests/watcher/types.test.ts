import { describe, expect, test } from 'bun:test';
import { WatcherConfigSchema } from '../../src/config';
import { NEURON_KINDS, WATCHER_DEFAULTS, emptyCounts } from '../../src/watcher/types';

describe('watcher types', () => {
  test('config schema defaults match WATCHER_DEFAULTS', () => {
    expect(WatcherConfigSchema.parse(undefined)).toEqual(WATCHER_DEFAULTS);
  });

  test('the watcher is off by default', () => {
    expect(WATCHER_DEFAULTS.enabled).toBe(false);
    expect(WATCHER_DEFAULTS.notice.enabled).toBe(false);
    expect(WATCHER_DEFAULTS.integrate.enabled).toBe(false);
  });

  test('emptyCounts has a zero for every neuron kind', () => {
    const counts = emptyCounts();
    expect(Object.keys(counts).sort()).toEqual([...NEURON_KINDS].sort());
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});

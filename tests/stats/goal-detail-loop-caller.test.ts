import { describe, expect, test } from 'bun:test';
import { isLoopCaller } from '../../src/stats/goal-detail-aggregator';

describe('isLoopCaller', () => {
  test('planner, strategist, executor and curiosity callers are the loop', () => {
    for (const c of ['planner', 'strategist', 'executor', 'curiosity:extractor']) {
      expect(isLoopCaller(c)).toBe(true);
    }
  });

  test('watcher callers never are (they run outside any bot cycle)', () => {
    expect(isLoopCaller('watcher:notice')).toBe(false);
    expect(isLoopCaller('watcher:integrate')).toBe(false);
  });

  test('conversation callers are not', () => {
    expect(isLoopCaller('conversation')).toBe(false);
  });

  test('the self-improve lesson writer runs inside a cycle', () => {
    expect(isLoopCaller('self-improve')).toBe(true);
  });
});

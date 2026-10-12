import { describe, expect, test } from 'bun:test';
import { countDispatchedRuns, isDispatchOnlyCycle } from '../../src/workers/dispatch-cycle';
import type { WorkerPoolApi, WorkerRunView } from '../../src/workers/types';

const pool = (runs: Partial<WorkerRunView>[], seen: unknown[] = []) =>
  ({
    list: (botId?: string, opts?: unknown) => {
      seen.push([botId, opts]);
      return runs as WorkerRunView[];
    },
  }) as unknown as WorkerPoolApi;

describe('countDispatchedRuns', () => {
  test('counts runs (active or ended) whose dispatchCycleId is the cycle', () => {
    const seen: unknown[] = [];
    const p = pool(
      [
        { runId: 'a', dispatchCycleId: 'c-1', status: 'running' },
        { runId: 'b', dispatchCycleId: 'c-1', status: 'done' },
        { runId: 'c', dispatchCycleId: 'c-0', status: 'running' },
        { runId: 'd', dispatchCycleId: null, status: 'running' },
      ],
      seen
    );
    expect(countDispatchedRuns(p, 'b1', 'c-1')).toBe(2);
    expect(seen[0]).toEqual(['b1', { endedLimit: 50 }]);
  });

  test('no pool, no cycle id or a throwing pool → 0', () => {
    expect(countDispatchedRuns(undefined, 'b1', 'c-1')).toBe(0);
    expect(countDispatchedRuns(pool([{ dispatchCycleId: 'c-1' }]), 'b1', undefined)).toBe(0);
    const bad = {
      list: () => {
        throw new Error('x');
      },
    } as unknown as WorkerPoolApi;
    expect(countDispatchedRuns(bad, 'b1', 'c-1')).toBe(0);
  });
});

describe('isDispatchOnlyCycle', () => {
  test('dispatched work and no tool call of its own', () => {
    expect(isDispatchOnlyCycle({ toolCalls: [], dispatched: 1 })).toBe(true);
    expect(isDispatchOnlyCycle({ toolCalls: [{ name: 'web_search' }], dispatched: 1 })).toBe(false);
    expect(isDispatchOnlyCycle({ toolCalls: [], dispatched: 0 })).toBe(false);
  });
});

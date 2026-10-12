/**
 * A cycle whose plan only handed tasks to workers (C22): it dispatched at
 * least one run and called no tool of its own. Repetition karma exempts it —
 * dispatching the same task family cycle after cycle is the loop working, not
 * the agent repeating itself; the runs are scored on their own outcomes.
 */

import type { WorkerPoolApi } from './types';

/** Runs (active or recently ended) the pool says this cycle dispatched. Never throws. */
export function countDispatchedRuns(
  pool: Pick<WorkerPoolApi, 'list'> | null | undefined,
  botId: string,
  cycleId: string | null | undefined
): number {
  if (!pool || !cycleId) return 0;
  try {
    return pool.list(botId, { endedLimit: 50 }).filter((r) => r.dispatchCycleId === cycleId).length;
  } catch {
    return 0;
  }
}

export function isDispatchOnlyCycle(input: {
  toolCalls: ReadonlyArray<{ name: string }>;
  dispatched: number;
}): boolean {
  return input.dispatched > 0 && input.toolCalls.length === 0;
}

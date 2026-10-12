import type {
  DispatchResult,
  JournalEntry,
  StopReason,
  WorkerEvent,
  WorkerPoolApi,
  WorkerRunView,
} from '../../src/workers/types';
import { isActiveRun } from '../../src/workers/types';

/** A run view with sensible defaults, for route and helper tests. */
export function makeRun(over: Partial<WorkerRunView> = {}): WorkerRunView {
  return {
    runId: 'r-1',
    botId: 'b1',
    taskId: 't-1',
    goalId: 'g-1',
    dispatchCycleId: 'c-1',
    taskText: 'Find 3 companies',
    goalTitle: 'Dark factory research',
    status: 'running',
    attempt: 1,
    step: 2,
    budget: { steps: 8, toolCalls: 40, wallMs: 3_600_000 },
    used: { steps: 2, toolCalls: 5, wallMs: 120_000 },
    createdAt: '2026-10-12T09:00:00.000Z',
    startedAt: '2026-10-12T09:00:01.000Z',
    ...over,
  };
}

export interface FakePool extends WorkerPoolApi {
  runs: WorkerRunView[];
  journals: Record<string, JournalEntry[]>;
  stops: Array<{ runId: string; reason: StopReason }>;
  retries: string[];
  enabled: boolean;
}

/** An in-memory WorkerPoolApi: list/get/journal from `runs`, records stop/retry. */
export function createFakePool(runs: WorkerRunView[] = []): FakePool {
  const pool: FakePool = {
    runs,
    journals: {},
    stops: [],
    retries: [],
    enabled: true,
    isEnabledFor: () => pool.enabled,
    dispatch: () => [],
    list(botId, opts) {
      const mine = pool.runs.filter((r) => !botId || r.botId === botId);
      const active = mine.filter((r) => isActiveRun(r.status));
      const ended = mine.filter((r) => !isActiveRun(r.status)).slice(0, opts?.endedLimit ?? 0);
      return [...active, ...ended];
    },
    get: (runId) => pool.runs.find((r) => r.runId === runId) ?? null,
    journal: (runId) => pool.journals[runId] ?? [],
    stop(runId, reason) {
      pool.stops.push({ runId, reason });
      const r = pool.runs.find((x) => x.runId === runId);
      return Boolean(r && isActiveRun(r.status));
    },
    retry(runId): DispatchResult {
      pool.retries.push(runId);
      const r = pool.runs.find((x) => x.runId === runId);
      if (!r) return { taskId: '', ok: false, reason: 'not-found', message: 'No such run' };
      if (isActiveRun(r.status))
        return { taskId: r.taskId, ok: false, reason: 'claimed', message: 'Still running' };
      return { taskId: r.taskId, ok: true, runId: `${runId}-retry`, queued: true };
    },
    onAnswer: () => {},
    abortAll: async () => {},
    recover: () => {},
    stats: () => ({ running: 0, queued: 0, waiting: 0, byBot: {} }),
    subscribe: (_l: (e: WorkerEvent) => void) => () => {},
  };
  return pool;
}

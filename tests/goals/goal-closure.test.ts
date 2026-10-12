import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoalEvents } from '../../src/bot/goal-events';
import { closeGoalTasks } from '../../src/goals/goal-closure';
import { TaskStore } from '../../src/goals/task-store';
import type { WorkerPoolApi, WorkerRunView } from '../../src/workers/types';

const GOALS = `## Active Goals
- [ ] Research dark factories
  - status: in_progress
  - id: g-aaaaaaaa
- [ ] Write the newsletter
  - status: pending
  - id: g-bbbbbbbb
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-closure-'));
  writeFileSync(join(dir, 'GOALS.md'), GOALS, 'utf-8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(over: Partial<WorkerRunView>): WorkerRunView {
  return {
    runId: 'r-1',
    botId: 'b1',
    taskId: 't-x',
    goalId: 'g-aaaaaaaa',
    dispatchCycleId: 'c-1',
    taskText: 'x',
    goalTitle: null,
    status: 'running',
    attempt: 1,
    step: 0,
    budget: { steps: 8, toolCalls: 40, wallMs: 1000 },
    used: { steps: 0, toolCalls: 0, wallMs: 0 },
    createdAt: '2026-10-12T10:00:00.000Z',
    ...over,
  };
}

function fakePool(runs: WorkerRunView[]) {
  const stopped: Array<[string, string]> = [];
  const pool = {
    list: (botId?: string) => runs.filter((r) => !botId || r.botId === botId),
    stop: (runId: string, reason: string) => {
      stopped.push([runId, reason]);
      return true;
    },
  } as unknown as WorkerPoolApi;
  return { pool, stopped };
}

function seed() {
  const store = new TaskStore(dir);
  const r = store.apply(
    [
      { op: 'add', goalId: 'g-aaaaaaaa', text: 'Find three factories' },
      { op: 'add', goalId: 'g-aaaaaaaa', text: 'Summarise the findings' },
      { op: 'add', goalId: 'g-bbbbbbbb', text: 'Draft the intro' },
    ],
    { actor: 'agent' }
  );
  if (!r.ok) throw new Error(r.message);
  const [a1, a2, b1] = r.results.map((x) => x.id);
  const c1 = store.apply([{ op: 'claim', id: a1, runId: 'r-1', ttlMs: 60_000 }], {
    actor: 'system',
  });
  const c2 = store.apply([{ op: 'claim', id: b1, runId: 'r-3', ttlMs: 60_000 }], {
    actor: 'system',
  });
  if (!c1.ok || !c2.ok) throw new Error('claim failed');
  return { store, a1, a2, b1 };
}

describe('closeGoalTasks', () => {
  test('stops the active runs of the goal and releases its claims, nothing else', () => {
    const { store, a1, a2, b1 } = seed();
    const { pool, stopped } = fakePool([
      run({ runId: 'r-1', taskId: a1 }),
      run({ runId: 'r-2', taskId: a2, status: 'done' }),
      run({ runId: 'r-3', taskId: b1, goalId: 'g-bbbbbbbb' }),
    ]);
    const res = closeGoalTasks({
      botId: 'b1',
      goalIds: ['g-aaaaaaaa'],
      store,
      pool,
      cycleId: 'c-9',
    });
    expect(stopped).toEqual([['r-1', 'goal-closed']]);
    expect(res).toEqual({ stopped: ['r-1'], released: [a1] });
    expect(store.get(a1)?.claim).toBeUndefined();
    expect(store.get(b1)?.claim?.runId).toBe('r-3');
    const rel = readGoalEvents(dir).filter((e) => e.op === 'task-release');
    expect(rel).toEqual([
      expect.objectContaining({ taskId: a1, runId: 'r-1', actor: 'system', cycleId: 'c-9' }),
    ]);
  });

  test('a run whose goalId matches is stopped even if its task is gone', () => {
    const { store } = seed();
    const { pool, stopped } = fakePool([run({ runId: 'r-7', taskId: 't-gone' })]);
    closeGoalTasks({ botId: 'b1', goalIds: ['g-aaaaaaaa'], store, pool });
    expect(stopped).toEqual([['r-7', 'goal-closed']]);
  });

  test('works without a pool and never throws', () => {
    const { store, a1 } = seed();
    const res = closeGoalTasks({ botId: 'b1', goalIds: ['g-aaaaaaaa'], store });
    expect(res.released).toEqual([a1]);
    const broken = {
      list: () => {
        throw new Error('boom');
      },
    } as unknown as TaskStore;
    expect(
      closeGoalTasks({ botId: 'b1', goalIds: ['g-aaaaaaaa'], store: broken, pool: undefined })
    ).toEqual({ stopped: [], released: [] });
  });

  test('no goal ids: no-op', () => {
    const { store } = seed();
    const { pool, stopped } = fakePool([run({})]);
    expect(closeGoalTasks({ botId: 'b1', goalIds: [], store, pool })).toEqual({
      stopped: [],
      released: [],
    });
    expect(stopped).toEqual([]);
  });
});

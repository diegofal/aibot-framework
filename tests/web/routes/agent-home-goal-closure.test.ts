/**
 * C21: the operator completing or deleting a goal stops its workers and
 * releases the claims on its tasks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { TaskStore } from '../../../src/goals/task-store';
import { parseGoals } from '../../../src/tools/goals';
import { agentHomeRoutes } from '../../../src/web/routes/agent-home';
import type { WorkerPoolApi, WorkerRunView } from '../../../src/workers/types';
import { removeTempDir } from '../../helpers/temp-dir';
import { type StatsFixture, createStatsFixture } from '../../stats/fixture';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

let fx: StatsFixture;
beforeEach(() => {
  fx = createStatsFixture();
});
afterEach(() => removeTempDir(fx.dir));

function setup() {
  const stopped: string[] = [];
  let runs: WorkerRunView[] = [];
  const pool = {
    list: () => runs,
    stop: (id: string, reason: string) => {
      stopped.push(`${id}:${reason}`);
      return true;
    },
  } as unknown as WorkerPoolApi;
  const app = new Hono();
  app.route(
    '/api/agents',
    agentHomeRoutes({
      config: fx.config,
      botManager: {
        isRunning: () => true,
        getAgentLoopState: () => ({ botSchedules: [] }) as never,
      },
      logger: noopLogger,
      now: () => fx.now,
      workerPool: () => pool,
    })
  );
  const send = (method: string, body: unknown) =>
    app.request('/api/agents/b1/goals', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const setRuns = (r: WorkerRunView[]) => {
    runs = r;
  };
  return { app, send, stopped, setRuns };
}

async function goalWithClaimedTask(send: (m: string, b: unknown) => Promise<Response>) {
  await send('POST', { title: 'Closable goal' });
  const goalsMd = readFileSync(join(fx.soulDir('b1'), 'GOALS.md'), 'utf-8');
  const goalId = parseGoals(goalsMd).active.find((g) => g.text === 'Closable goal')?.id as string;
  const store = new TaskStore(fx.soulDir('b1'));
  const r = store.apply([{ op: 'add', goalId, text: 'Do the first step' }], { actor: 'agent' });
  if (!r.ok) throw new Error(r.message);
  const taskId = r.results[0].id;
  store.apply([{ op: 'claim', id: taskId, runId: 'r-1', ttlMs: 60_000 }], { actor: 'system' });
  const run = { runId: 'r-1', botId: 'b1', taskId, goalId, status: 'running' } as WorkerRunView;
  return { goalId, taskId, store, run };
}

describe('operator closes a goal', () => {
  it('PATCH status done stops its runs and releases claims', async () => {
    const { send, stopped, setRuns } = setup();
    const { goalId, taskId, store, run } = await goalWithClaimedTask(send);
    setRuns([run]);
    const res = await send('PATCH', { id: goalId, status: 'done' });
    expect(res.status).toBe(200);
    expect(stopped).toEqual(['r-1:goal-closed']);
    expect(store.get(taskId)?.claim).toBeUndefined();
  });

  it('PATCH to another status leaves workers alone', async () => {
    const { send, stopped, setRuns } = setup();
    const { goalId, taskId, store, run } = await goalWithClaimedTask(send);
    setRuns([run]);
    await send('PATCH', { id: goalId, status: 'blocked' });
    expect(stopped).toEqual([]);
    expect(store.get(taskId)?.claim?.runId).toBe('r-1');
  });

  it('DELETE stops its runs and releases claims', async () => {
    const { send, stopped, setRuns } = setup();
    const { goalId, taskId, store, run } = await goalWithClaimedTask(send);
    setRuns([run]);
    const res = await send('DELETE', { goal: 'Closable goal' });
    expect(res.status).toBe(200);
    expect(stopped).toEqual(['r-1:goal-closed']);
    expect(store.get(taskId)?.claim).toBeUndefined();
    expect(goalId).toMatch(/^g-/);
  });
});

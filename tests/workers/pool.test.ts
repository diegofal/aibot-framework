/**
 * WorkerPool (plan C10, C16): admission, the queue, stop/retry/answers,
 * shutdown + boot recovery, the sweep and the events — on real TaskStores
 * (claims are the store's CAS) with a scripted fake turn runner.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/goals/task-store';
import { WorkerPool, type WorkerPoolDeps } from '../../src/workers/pool';
import { WorkerRunStore } from '../../src/workers/run-store';
import {
  type JournalEntry,
  WORKERS_DEFAULTS,
  type WorkerEvent,
  type WorkersConfig,
} from '../../src/workers/types';
import type { WorkerTurnRequest } from '../../src/workers/worker';

const GOALS = `## Active Goals
- [ ] High goal
  - status: pending
  - priority: high
  - id: g-aaaaaaaa
- [ ] Medium goal
  - status: pending
  - priority: medium
  - id: g-bbbbbbbb
`;

type Step = Array<{ name: string; args?: Record<string, unknown> }> | 'hang' | 'error';

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worker-pool-'));
  clock = Date.parse('2026-10-12T10:00:00.000Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function soulDir(botId: string): string {
  const d = join(root, 'soul', botId);
  if (!existsSync(d)) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'GOALS.md'), GOALS, 'utf-8');
  }
  return d;
}

const stores = new Map<string, TaskStore>();
function tasks(botId: string): TaskStore {
  const key = `${root}:${botId}`;
  let s = stores.get(key);
  if (!s) {
    s = new TaskStore(soulDir(botId), { now: () => new Date(clock) });
    stores.set(key, s);
  }
  return s;
}

function addTask(botId: string, goalId: string, text: string): string {
  const r = tasks(botId).apply([{ op: 'add', goalId, text }], { actor: 'operator' });
  if (!r.ok) throw new Error(r.message);
  return r.results[0].id;
}

const progress = (note = 'step') => ({ name: 'task_progress', args: { note } });
const done = (note = 'finished') => ({ name: 'task_done', args: { note } });

interface Harness {
  pool: WorkerPool;
  events: WorkerEvent[];
  published: Array<{ type: string }>;
  requests: WorkerTurnRequest[];
  wakes: string[];
  scripts: Map<string, Step[]>;
  waits: Map<string, () => void>;
  breakerOpen: Set<string>;
  quota: { ok: boolean };
  opsLog: string[];
}

function makePool(
  config: Partial<WorkersConfig> = {},
  opts: {
    scripts?: Map<string, Step[]>;
    onTurn?: (req: WorkerTurnRequest, pool: WorkerPool) => void;
  } = {}
): Harness {
  const events: WorkerEvent[] = [];
  const published: Array<{ type: string }> = [];
  const requests: WorkerTurnRequest[] = [];
  const wakes: string[] = [];
  const scripts = opts.scripts ?? new Map<string, Step[]>();
  const waits = new Map<string, () => void>();
  const breakerOpen = new Set<string>();
  const quota = { ok: true };
  const opsLog: string[] = [];
  const cfg: WorkersConfig = { ...WORKERS_DEFAULTS, enabled: true, ...config };
  const deps: WorkerPoolDeps = {
    config: () => cfg,
    store: new WorkerRunStore(join(root, 'data')),
    botIds: () => ['b1', 'b2'],
    taskStore: (botId) => {
      const s = tasks(botId);
      return {
        get: (id) => s.get(id),
        list: () => s.list(),
        apply: (ops, o) => {
          for (const op of ops) opsLog.push(`${op.op}:${'id' in op ? op.id : ''}`);
          return s.apply(ops, o);
        },
      };
    },
    goals: () => [
      { id: 'g-aaaaaaaa', text: 'High goal', priority: 'high' },
      { id: 'g-bbbbbbbb', text: 'Medium goal', priority: 'medium' },
    ],
    productionsDir: (botId) => join(root, 'productions', botId),
    botBackend: () => 'claude-cli',
    breaker: { isOpen: (b) => breakerOpen.has(b) },
    quotaOk: () => quota.ok,
    activityStream: { publish: (e) => published.push(e) },
    wake: (botId) => wakes.push(botId),
    wakeDebounceMs: 5,
    now: () => clock,
    runTurnFor: () => async (req) => {
      requests.push(req);
      opts.onTurn?.(req, pool);
      const taskId = req.attribution.taskId as string;
      const list = scripts.get(taskId) ?? [];
      const script = list.shift() ?? 'hang';
      if (script === 'error')
        return { ok: false, stopReason: 'error', error: new Error('llm down'), text: '' };
      if (script === 'hang') {
        await new Promise<void>((resolve) => {
          waits.set(taskId, resolve);
          if (req.signal.aborted) resolve();
          else req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { ok: false, stopReason: 'aborted', error: new Error('aborted'), text: '' };
      }
      const cb = req.wrapToolCallback(async (name, args) => {
        const extra = req.extraTools.find((t) => t.definition.function.name === name);
        const result = extra
          ? await extra.execute(args, undefined as never)
          : { success: true, content: 'ok' };
        req.onToolEnd({
          toolName: name,
          args,
          success: result.success,
          result: result.content,
          durationMs: 1,
          retryAttempts: 0,
          botId: 'b1',
          chatId: 0,
          timestamp: clock,
        });
        return result;
      });
      for (const c of script) await cb(c.name, c.args ?? {});
      return { ok: true, stopReason: 'completed', text: '' };
    },
  };
  const pool = new WorkerPool(deps);
  pool.subscribe((e) => events.push(e));
  return { pool, events, published, requests, wakes, scripts, waits, breakerOpen, quota, opsLog };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting');
    await settle(5);
  }
}

afterEach(() => stores.clear());

describe('admission', () => {
  test('disabled or outside the allowlist: refused', () => {
    const off = makePool({ enabled: false });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    expect(off.pool.isEnabledFor('b1')).toBe(false);
    expect(off.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: 'c-1' })[0]).toMatchObject({
      ok: false,
      reason: 'disabled',
    });
    const listed = makePool({ bots: ['b2'] });
    expect(listed.pool.isEnabledFor('b1')).toBe(false);
    expect(listed.pool.isEnabledFor('b2')).toBe(true);
    listed.pool.dispose();
    off.pool.dispose();
  });

  test('per-bot cap: one runs, one waits in the queue, the next is refused', async () => {
    const h = makePool({ maxPerBot: 1 });
    const ids = ['a', 'b', 'c'].map((x) => addTask('b1', 'g-aaaaaaaa', `task ${x}`));
    const res = h.pool.dispatch({ botId: 'b1', taskIds: ids, cycleId: 'c-1' });
    expect(res[0]).toMatchObject({ ok: true, queued: false });
    expect(res[1]).toMatchObject({ ok: true, queued: true });
    expect(res[2]).toMatchObject({ ok: false, reason: 'cap' });
    expect(h.pool.stats()).toMatchObject({ running: 1, queued: 1 });
    expect(tasks('b1').get(ids[2])?.claim).toBeUndefined();
    await h.pool.abortAll('shutdown');
    h.pool.dispose();
  });

  test('fleet cap: the second bot waits until a slot frees', async () => {
    const h = makePool({ maxConcurrent: 1 });
    const t1 = addTask('b1', 'g-aaaaaaaa', 'one');
    const t2 = addTask('b2', 'g-aaaaaaaa', 'two');
    expect(h.pool.dispatch({ botId: 'b1', taskIds: [t1], cycleId: null })[0]).toMatchObject({
      queued: false,
    });
    const r2 = h.pool.dispatch({ botId: 'b2', taskIds: [t2], cycleId: null })[0];
    expect(r2).toMatchObject({ ok: true, queued: true });
    const run1 = h.pool.list('b1')[0];
    expect(h.pool.stop(run1.runId, 'operator')).toBe(true);
    await until(() => h.pool.stats().byBot.b2?.running === 1);
    await h.pool.abortAll('shutdown');
    h.pool.dispose();
  });

  test('one run per task; claimed, done and unknown tasks are refused', () => {
    const h = makePool({ maxPerBot: 3 });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    const d = addTask('b1', 'g-aaaaaaaa', 'done one');
    tasks('b1').apply([{ op: 'move', id: d, lane: 'done' }], { actor: 'operator' });
    const res = h.pool.dispatch({ botId: 'b1', taskIds: [t, t, d, 't-nope00'], cycleId: 'c-1' });
    expect(res.map((r) => (r.ok ? 'ok' : r.reason))).toEqual([
      'ok',
      'claimed',
      'done',
      'not-found',
    ]);
    expect(h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: 'c-2' })[0]).toMatchObject({
      ok: false,
      reason: 'claimed',
    });
    void h.pool.abortAll('shutdown');
    h.pool.dispose();
  });

  test('claim CAS: two pools on one soul dir never both claim a task', async () => {
    const a = makePool();
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    expect(a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null })[0].ok).toBe(true);
    const b = makePool();
    expect(b.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null })[0]).toMatchObject({
      ok: false,
      reason: 'claimed',
    });
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
    b.pool.dispose();
  });

  test('daily step budget and tenant quota refuse', async () => {
    const h = makePool({ dailyStepsPerBot: 1 });
    const t1 = addTask('b1', 'g-aaaaaaaa', 'one');
    const t2 = addTask('b1', 'g-aaaaaaaa', 'two');
    h.scripts.set(t1, [[done()]]);
    h.pool.dispatch({ botId: 'b1', taskIds: [t1], cycleId: null });
    await until(() => h.pool.stats().running === 0 && h.pool.list('b1')[0]?.status === 'done');
    expect(h.pool.dispatch({ botId: 'b1', taskIds: [t2], cycleId: null })[0]).toMatchObject({
      ok: false,
      reason: 'budget',
    });
    const q = makePool();
    q.quota.ok = false;
    expect(
      q.pool.dispatch({
        botId: 'b2',
        taskIds: [addTask('b2', 'g-aaaaaaaa', 'x')],
        cycleId: null,
      })[0]
    ).toMatchObject({
      ok: false,
      reason: 'quota',
    });
    h.pool.dispose();
    q.pool.dispose();
  });

  test('breaker open for the bot backend: stays queued until it closes', async () => {
    const h = makePool();
    h.breakerOpen.add('claude-cli');
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, [[done()]]);
    expect(h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null })[0]).toMatchObject({
      ok: true,
      queued: true,
    });
    await settle();
    expect(h.requests).toHaveLength(0);
    h.breakerOpen.clear();
    h.pool.sweep();
    await until(() => h.pool.list('b1')[0]?.status === 'done');
    h.pool.dispose();
  });

  test('the queue serves goal priority first', async () => {
    const h = makePool({ maxConcurrent: 1, maxPerBot: 2 });
    const blocker = addTask('b1', 'g-bbbbbbbb', 'blocker');
    const med = addTask('b1', 'g-bbbbbbbb', 'medium');
    const high = addTask('b1', 'g-aaaaaaaa', 'high');
    h.scripts.set(med, [[done()]]);
    h.scripts.set(high, [[done()]]);
    h.pool.dispatch({ botId: 'b1', taskIds: [blocker], cycleId: null });
    h.pool.dispatch({ botId: 'b1', taskIds: [med, high], cycleId: null });
    h.pool.stop(h.pool.list('b1').find((r) => r.taskId === blocker)?.runId as string, 'operator');
    await until(() => h.requests.length >= 3);
    expect(h.requests[1].attribution.taskId).toBe(high);
    h.pool.dispose();
  });
});

describe('runs', () => {
  test('a run reports, ends done, emits every event and wakes the bot once', async () => {
    const h = makePool({ maxPerBot: 2 });
    const t1 = addTask('b1', 'g-aaaaaaaa', 'one');
    const t2 = addTask('b1', 'g-aaaaaaaa', 'two');
    h.scripts.set(t1, [
      [{ name: 'web_fetch', args: { url: 'https://a.io' } }, progress()],
      [done('ok')],
    ]);
    h.scripts.set(t2, [[done('ok')]]);
    h.pool.dispatch({ botId: 'b1', taskIds: [t1, t2], cycleId: 'c-1' });
    await until(() => h.pool.list('b1').every((r) => r.status === 'done') && h.wakes.length > 0);
    await settle(30);
    const types = new Set(h.events.map((e) => e.type));
    for (const t of [
      'worker:queued',
      'worker:started',
      'worker:step',
      'worker:tool',
      'worker:ended',
    ])
      expect(types.has(t as never)).toBe(true);
    expect(h.published.some((e) => e.type === 'worker:ended')).toBe(true);
    const ended = h.events.find((e) => e.type === 'worker:ended');
    expect(ended?.data).toMatchObject({
      taskId: expect.any(String),
      status: 'done',
      outcome: { kind: 'done' },
    });
    expect(h.wakes).toEqual(['b1']);
    expect(tasks('b1').get(t1)?.lane).toBe('done');
    expect(tasks('b1').get(t1)?.claim).toBeUndefined();
    const view = h.pool.get(h.pool.list('b1')[0].runId);
    expect(view).not.toHaveProperty('claimToken');
    expect(h.pool.journal(view?.runId as string).at(-1)?.kind).toBe('run-end');
    h.pool.dispose();
  });

  test('two runs never share a write root', async () => {
    const h = makePool({ maxPerBot: 2 });
    const t1 = addTask('b1', 'g-aaaaaaaa', 'one');
    const t2 = addTask('b1', 'g-aaaaaaaa', 'two');
    h.pool.dispatch({ botId: 'b1', taskIds: [t1, t2], cycleId: null });
    await until(() => h.requests.length === 2);
    expect(h.requests[0].workDir).not.toBe(h.requests[1].workDir);
    for (const r of h.requests) expect(existsSync(r.workDir)).toBe(true);
    await h.pool.abortAll('shutdown');
    h.pool.dispose();
  });

  test('operator stop aborts the step, task back to To do, claim released', async () => {
    const h = makePool();
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => h.requests.length === 1);
    const runId = h.pool.list('b1')[0].runId;
    expect(h.pool.stop(runId, 'operator')).toBe(true);
    await until(() => h.pool.get(runId)?.status === 'stopped');
    expect(h.requests[0].signal.aborted).toBe(true);
    const task = tasks('b1').get(t);
    expect(task?.lane).toBe('todo');
    expect(task?.claim).toBeUndefined();
    expect(h.pool.stop(runId, 'operator')).toBe(false);
    h.pool.dispose();
  });

  test('a failure at the last attempt sends the task to Blocked; retry starts attempt + 1', async () => {
    const h = makePool({ maxAttempts: 1 });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, ['error', [done()]]);
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => h.pool.get(runId)?.status === 'failed');
    expect(tasks('b1').get(t)?.lane).toBe('blocked');
    const again = h.pool.retry(runId);
    expect(again.ok).toBe(true);
    const next = h.pool.get((again as { runId: string }).runId);
    expect(next?.attempt).toBe(2);
    await until(() => h.pool.get(next?.runId as string)?.status === 'done');
    h.pool.dispose();
  });

  test('a waiting run resumes with the answer in its journal and prompt', async () => {
    let parked = false;
    const h = makePool(
      {},
      {
        onTurn: (req, pool) => {
          if (parked) return;
          parked = true;
          pool.markWaiting(req.attribution.runId as string, {
            kind: 'ask',
            id: 'q-1',
            question: 'Which tone?',
            since: new Date(clock).toISOString(),
          });
        },
      }
    );
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, [[progress('asked')], [done()]]);
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => h.pool.get(runId)?.status === 'waiting');
    expect(h.events.some((e) => e.type === 'worker:waiting')).toBe(true);
    expect(h.pool.stats().waiting).toBe(1);
    h.pool.onAnswer(runId, { kind: 'ask', id: 'q-1', answer: 'Formal' });
    await until(() => h.pool.get(runId)?.status === 'done');
    expect(h.requests[1].prompt.user).toContain('Formal');
    expect(h.pool.journal(runId).some((e) => e.kind === 'resume')).toBe(true);
    h.pool.dispose();
  });

  test('a dismissed question ends the waiting run blocked', async () => {
    const h = makePool(
      {},
      {
        onTurn: (req, pool) =>
          pool.markWaiting(req.attribution.runId as string, {
            kind: 'ask',
            id: 'q-9',
            question: 'q',
            since: 'x',
          }),
      }
    );
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, [[progress()]]);
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => h.pool.get(runId)?.status === 'waiting');
    h.pool.onAnswer(runId, { kind: 'ask', id: 'q-9', dismissed: true });
    expect(h.pool.get(runId)?.status).toBe('blocked');
    expect(tasks('b1').get(t)?.lane).toBe('blocked');
    h.pool.dispose();
  });
});

describe('shutdown and recovery', () => {
  const runsJson = () =>
    JSON.parse(readFileSync(join(root, 'data', 'workers', 'b1', 'runs.json'), 'utf-8'))
      .runs as Array<{
      status: string;
      runId: string;
    }>;

  test('abortAll persists interrupted synchronously, before it resolves', async () => {
    const h = makePool();
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => h.requests.length === 1);
    const p = h.pool.abortAll('shutdown');
    expect(runsJson().map((r) => r.status)).toEqual(['interrupted']);
    await p;
    expect(runsJson().map((r) => r.status)).toEqual(['interrupted']);
    expect(tasks('b1').get(t)?.claim).toBeDefined();
    h.pool.dispose();
  });

  test('recover re-binds every claim before queueing, then resumes at attempt + 1', async () => {
    const a = makePool();
    const t1 = addTask('b1', 'g-aaaaaaaa', 'one');
    a.scripts.set(t1, [[progress('first half')], 'hang']);
    a.pool.dispatch({ botId: 'b1', taskIds: [t1], cycleId: 'c-1' });
    await until(() => a.requests.length === 2);
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
    // The claim got lost while down (e.g. released by hand): recover re-claims.
    const tok = tasks('b1').get(t1)?.claim?.token as string;
    tasks('b1').apply([{ op: 'release', id: t1, token: tok, lane: 'todo' }], { actor: 'system' });

    const b = makePool();
    b.scripts.set(t1, [[done('second half')]]);
    b.pool.subscribe((e) => b.opsLog.push(`event:${e.type}`));
    const opsBefore = b.opsLog.length;
    b.pool.recover();
    const timeline = b.opsLog.slice(opsBefore);
    const lastBind = Math.max(
      ...timeline.map((o, i) => (o.startsWith('claim') || o.startsWith('renew') ? i : -1))
    );
    const firstEvent = timeline.findIndex((o) => o.startsWith('event:'));
    expect(lastBind).toBeGreaterThanOrEqual(0);
    expect(firstEvent).toBeGreaterThan(lastBind);
    expect(timeline[firstEvent]).toBe('event:worker:queued');
    expect(b.pool.dispatch({ botId: 'b1', taskIds: [t1], cycleId: 'c-2' })[0]).toMatchObject({
      ok: false,
      reason: 'claimed',
    });
    const run = b.pool.list('b1')[0];
    expect(run.attempt).toBe(2);
    await until(() => b.pool.get(run.runId)?.status === 'done');
    // Step 1 was finished before the restart: it is not run again.
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0].prompt.user).toContain('first half');
    expect(b.pool.get(run.runId)?.step).toBe(2);
    b.pool.dispose();
  });

  test('a step that ran an external tool is not replayed: blocked for the operator', async () => {
    const a = makePool();
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => a.requests.length === 1);
    const runId = a.pool.list('b1')[0].runId;
    // The step ran `exec` and then the process died.
    new WorkerRunStore(join(root, 'data')).appendJournal('b1', runId, {
      ts: new Date(clock).toISOString(),
      runId,
      kind: 'tool',
      n: 1,
      name: 'exec',
      ok: true,
      sideEffect: 'external',
      target: 'curl -X POST',
    } as JournalEntry);
    await a.pool.abortAll('shutdown');
    a.pool.dispose();

    const b = makePool();
    b.pool.recover();
    const ended = b.pool.get(runId);
    expect(ended?.status).toBe('blocked');
    expect(ended?.outcome?.kind).toBe('interrupted');
    expect(tasks('b1').get(t)?.lane).toBe('blocked');
    expect(tasks('b1').get(t)?.note).toContain('exec');
    await settle();
    expect(b.requests).toHaveLength(0);
    b.pool.dispose();
  });

  test('an interrupted run past maxAttempts is not resumed', async () => {
    const a = makePool({ maxAttempts: 1 });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => a.requests.length === 1);
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
    const b = makePool({ maxAttempts: 1 });
    b.pool.recover();
    expect(b.pool.list('b1')[0].status).toBe('failed');
    expect(tasks('b1').get(t)?.lane).toBe('blocked');
    b.pool.dispose();
  });
});

describe('sweep', () => {
  test('a run without heartbeat for 2× the step timeout is aborted and failed', async () => {
    const h = makePool({ stepTimeoutMs: 100_000, maxAttempts: 2 });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => h.requests.length === 1);
    const runId = h.pool.list('b1')[0].runId;
    clock += 200_001;
    h.pool.sweep();
    await until(() => h.pool.get(runId)?.status === 'failed');
    expect(h.requests[0].signal.aborted).toBe(true);
    const task = tasks('b1').get(t);
    expect(task?.lane).toBe('todo');
    expect(task?.note).toContain('stopped responding');
    h.pool.dispose();
  });

  test('an expired claim held by no run is released', () => {
    const h = makePool();
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    tasks('b1').apply([{ op: 'claim', id: t, runId: 'wr-ghost', ttlMs: 1000 }], {
      actor: 'system',
    });
    clock += 5000;
    h.pool.sweep();
    const task = tasks('b1').get(t);
    expect(task?.claim).toBeUndefined();
    expect(task?.lane).toBe('todo');
    h.pool.dispose();
  });
});

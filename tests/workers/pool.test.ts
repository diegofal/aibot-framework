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
import { AskHumanStore } from '../../src/bot/ask-human-store';
import { AskPermissionStore } from '../../src/bot/ask-permission-store';
import { TaskStore } from '../../src/goals/task-store';
import type { Logger } from '../../src/logger';
import type { ToolResult } from '../../src/tools/types';
import { WorkerPool, type WorkerPoolDeps } from '../../src/workers/pool';
import { WorkerRunStore } from '../../src/workers/run-store';
import {
  type JournalEntry,
  WORKERS_DEFAULTS,
  type WorkerAnswer,
  type WorkerEvent,
  type WorkerWait,
  type WorkersConfig,
} from '../../src/workers/types';
import { cancelWaitFrom, drainAnswersFrom, withdrawRunAsksFrom } from '../../src/workers/wiring';
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
    /** A non-report tool's result (default: ok). */
    tool?: (
      name: string,
      args: Record<string, unknown>,
      req: WorkerTurnRequest
    ) => Promise<ToolResult> | ToolResult;
    deps?: Partial<WorkerPoolDeps>;
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
          : opts.tool
            ? await opts.tool(name, args, req)
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
    ...opts.deps,
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

  test('recover re-binds every claim before queueing, then resumes (a clean stop uses no attempt, N4)', async () => {
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
    expect(run.attempt).toBe(1);
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

  test('a run cut mid-step by a crash, past maxAttempts, is not resumed', async () => {
    // Deliberately changed (N4): a clean stop (abortAll) costs no attempt, so
    // this is now a crash — the process dies with the run still `running`.
    const a = makePool({ maxAttempts: 1 });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => a.requests.length === 1);
    const b = makePool({ maxAttempts: 1 });
    b.pool.recover();
    expect(b.pool.list('b1')[0].status).toBe('failed');
    expect(tasks('b1').get(t)?.lane).toBe('blocked');
    b.pool.dispose();
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
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

function makeLogger() {
  const warns: string[] = [];
  const logger: any = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (_o: unknown, msg?: string) => warns.push(String(msg ?? _o)),
  };
  logger.child = () => logger;
  return { logger: logger as Logger, warns };
}

describe('review fixes: answers that arrive while the step runs (B1)', () => {
  function withStores() {
    const log = makeLogger();
    const ask = new AskHumanStore(log.logger, join(root, 'ask-human'));
    const perms = new AskPermissionStore(log.logger, join(root, 'ask-permission'));
    const asked: string[] = [];
    const harness = makePool(
      {},
      {
        tool: (name, args, req) => {
          if (name !== 'ask_human') return { success: true, content: 'ok' };
          const q = ask.ask('b1', 0, String(args.question), undefined, Date.now(), {
            runId: req.attribution.runId as string,
          });
          q.promise.catch(() => {});
          asked.push(q.id);
          if (typeof args.after === 'function') (args.after as (id: string) => void)(q.id);
          return { success: true, content: `Question sent (id ${q.id}) — the run will pause.` };
        },
        deps: {
          drainAnswers: drainAnswersFrom({
            askHumanStore: ask,
            askPermissionStore: perms,
          } as never),
        },
      }
    );
    const route = (runId: string, a: WorkerAnswer) => harness.pool.onAnswer(runId, a);
    ask.setRunRouter(route);
    perms.setRunRouter(route);
    return { ...harness, ask, perms, asked, log };
  }

  test('an answer given before the step ends resumes the run with it', async () => {
    const s = withStores();
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    s.scripts.set(t, [
      [
        {
          name: 'ask_human',
          args: { question: 'Which tone?', after: (id: string) => s.ask.answerById(id, 'Formal') },
        },
        progress('asked'),
      ],
      [done()],
    ]);
    const [r] = s.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => s.pool.get(runId)?.status === 'done');
    expect(s.requests[1].prompt.user).toContain('Formal');
    expect(s.ask.consumeAnswersForRun(runId)).toEqual([]);
    s.pool.dispose();
  });

  test('a dismissal before the step ends ends the run blocked', async () => {
    const s = withStores();
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    s.scripts.set(t, [
      [
        {
          name: 'ask_human',
          args: { question: 'Which tone?', after: (id: string) => s.ask.dismissById(id) },
        },
        progress('asked'),
      ],
      'hang',
    ]);
    const [r] = s.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => s.pool.get(runId)?.status === 'blocked');
    expect(tasks('b1').get(t)?.lane).toBe('blocked');
    expect(s.requests).toHaveLength(1);
    s.pool.dispose();
  });

  test('a second wait opened in the same step: its early answer is kept, not dropped', async () => {
    const s = withStores();
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    s.scripts.set(t, [
      [
        { name: 'ask_human', args: { question: 'Tone?' } },
        {
          name: 'ask_human',
          args: { question: 'Length?', after: (id: string) => s.ask.answerById(id, 'Short') },
        },
        progress('asked twice'),
      ],
      [done()],
    ]);
    const [r] = s.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => s.pool.get(runId)?.status === 'waiting');
    expect(s.pool.get(runId)?.wait?.id).toBe(s.asked[0]);
    // The sweep drains what the stores kept: the run keeps waiting for the first question.
    s.pool.sweep();
    expect(s.pool.get(runId)?.status).toBe('waiting');
    expect(s.ask.answerById(s.asked[0], 'Formal').ok).toBe(true);
    await until(() => s.pool.get(runId)?.status === 'done');
    expect(s.requests[1].prompt.user).toContain('Formal');
    expect(s.requests[1].prompt.user).toContain('Short');
    expect(s.requests[1].prompt.user).toContain('Length?');
    s.pool.dispose();
  });
});

describe('review fixes: stopping a waiting run withdraws its ask (S7)', () => {
  test('Stop on a waiting run withdraws the question; no answer is routed back', async () => {
    const cancelled: WorkerWait[] = [];
    const h = makePool(
      {},
      {
        onTurn: (req, pool) =>
          pool.markWaiting(req.attribution.runId as string, {
            kind: 'ask',
            id: 'q-5',
            question: 'q',
            since: 'x',
          }),
        deps: { cancelWait: (w) => cancelled.push(w) },
      }
    );
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, [[progress()]]);
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => h.pool.get(runId)?.status === 'waiting');
    expect(h.pool.stop(runId, 'operator')).toBe(true);
    expect(h.pool.get(runId)?.status).toBe('stopped');
    expect(cancelled).toMatchObject([{ kind: 'ask', id: 'q-5' }]);
    // A late answer for the ended run is not taken.
    expect(h.pool.onAnswer(runId, { kind: 'ask', id: 'q-5', answer: 'late' })).toBe(false);
    h.pool.dispose();
  });

  test('with the real stores: the pending question and permission are closed', async () => {
    const log = makeLogger();
    const ask = new AskHumanStore(log.logger, join(root, 'ask-human'));
    const perms = new AskPermissionStore(log.logger, join(root, 'ask-permission'));
    const q = ask.ask('b1', 0, 'Tone?', undefined, Date.now(), { runId: 'placeholder' });
    q.promise.catch(() => {});
    const p = perms.request('b1', 'exec', 'deploy', 'd', 'normal', { runId: 'placeholder' });
    const cancel = cancelWaitFrom({ askHumanStore: ask, askPermissionStore: perms } as never);
    cancel({ kind: 'ask', id: q.id, question: 'Tone?', since: 'x' });
    cancel({ kind: 'approval', id: p.id, question: 'exec', since: 'x' });
    expect(ask.getPendingForBot('b1')).toEqual([]);
    expect(perms.getPendingForBot('b1')).toEqual([]);
    expect(await p.promise).toBe('denied');
  });

  test('a dismissal that ends the run does not try to withdraw it again', async () => {
    const cancelled: WorkerWait[] = [];
    const h = makePool(
      {},
      {
        onTurn: (req, pool) =>
          pool.markWaiting(req.attribution.runId as string, {
            kind: 'ask',
            id: 'q-6',
            question: 'q',
            since: 'x',
          }),
        deps: { cancelWait: (w) => cancelled.push(w) },
      }
    );
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, [[progress()]]);
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => h.pool.get(runId)?.status === 'waiting');
    expect(h.pool.onAnswer(runId, { kind: 'ask', id: 'q-6', dismissed: true })).toBe(true);
    expect(h.pool.get(runId)?.status).toBe('blocked');
    expect(cancelled).toEqual([]);
    h.pool.dispose();
  });
});

describe('review fixes: in-flight external call at shutdown (S3)', () => {
  const hangingTool =
    (ran: string[]) =>
    async (name: string, _args: Record<string, unknown>, req: WorkerTurnRequest) => {
      ran.push(name);
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) resolve();
        else req.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { success: false, content: 'aborted' };
    };

  test('killed mid external call: recover ends the run blocked, the call is not re-run', async () => {
    const ran: string[] = [];
    const a = makePool({}, { tool: hangingTool(ran) });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    a.scripts.set(t, [[{ name: 'twitter_post', args: { text: 'launch!' } }, progress()]]);
    a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => ran.length === 1);
    const runId = a.pool.list('b1')[0].runId;
    // The process dies now: no abortAll, no tool end in the journal.
    const persisted = JSON.parse(
      readFileSync(join(root, 'data', 'workers', 'b1', 'runs.json'), 'utf-8')
    ).runs[0];
    expect(persisted).toMatchObject({ status: 'running', currentTool: 'twitter_post' });

    const b = makePool();
    b.pool.recover();
    const ended = b.pool.get(runId);
    expect(ended?.status).toBe('blocked');
    expect(ended?.outcome?.note).toContain('twitter_post');
    expect(tasks('b1').get(t)?.lane).toBe('blocked');
    await settle();
    expect(b.requests).toHaveLength(0);
    b.pool.dispose();
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
  });

  test('abortAll keeps the tool in flight on the interrupted record', async () => {
    const ran: string[] = [];
    const a = makePool({}, { tool: hangingTool(ran) });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    a.scripts.set(t, [[{ name: 'twitter_post', args: { text: 'launch!' } }, progress()]]);
    a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => ran.length === 1);
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
    const persisted = JSON.parse(
      readFileSync(join(root, 'data', 'workers', 'b1', 'runs.json'), 'utf-8')
    ).runs[0];
    expect(persisted).toMatchObject({ status: 'interrupted', currentTool: 'twitter_post' });
  });

  test('an in-flight read call is replayed as before', async () => {
    const ran: string[] = [];
    const a = makePool({}, { tool: hangingTool(ran) });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    a.scripts.set(t, [[{ name: 'web_search', args: { q: 'x' } }, progress()]]);
    a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => ran.length === 1);
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
    const b = makePool();
    b.scripts.set(t, [[done()]]);
    b.pool.recover();
    const run = b.pool.list('b1')[0];
    await until(() => b.pool.get(run.runId)?.status === 'done');
    b.pool.dispose();
  });
});

describe('review fixes: bot stop and start (S9, M2)', () => {
  test('a bot stop interrupts its runs and keeps their claims; kick resumes them', async () => {
    const running = { b1: true };
    const h = makePool({}, { deps: { isBotRunning: (b) => running[b as 'b1'] ?? false } });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, ['hang', [done('resumed')]]);
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => h.requests.length === 1);
    running.b1 = false;
    expect(h.pool.stop(runId, 'shutdown')).toBe(true);
    await until(() => h.pool.get(runId)?.status === 'interrupted');
    expect(tasks('b1').get(t)?.claim?.runId).toBe(runId);
    expect(h.pool.get(runId)?.outcome).toBeUndefined();
    expect(h.events.some((e) => e.type === 'worker:ended')).toBe(false);

    running.b1 = true;
    h.pool.kick('b1');
    await until(() => h.pool.get(runId)?.status === 'done');
    expect(h.pool.get(runId)?.attempt).toBe(1);
    h.pool.dispose();
  });

  test('a queued run interrupted by a bot stop resumes without using an attempt', async () => {
    const running = { b1: true };
    const h = makePool(
      { maxPerBot: 1 },
      { deps: { isBotRunning: (b) => running[b as 'b1'] ?? false } }
    );
    running.b1 = false;
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, [[done()]]);
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    expect(h.pool.get(runId)?.status).toBe('queued');
    h.pool.stop(runId, 'shutdown');
    expect(h.pool.get(runId)?.status).toBe('interrupted');
    running.b1 = true;
    h.pool.kick('b1');
    await until(() => h.pool.get(runId)?.status === 'done');
    expect(h.pool.get(runId)?.attempt).toBe(1);
    h.pool.dispose();
  });

  test('kick starts queued runs at once, without waiting for the sweep', async () => {
    const running = { b1: false };
    const h = makePool({}, { deps: { isBotRunning: (b) => running[b as 'b1'] ?? false } });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, [[done()]]);
    h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await settle();
    expect(h.requests).toHaveLength(0);
    running.b1 = true;
    h.pool.kick();
    await until(() => h.requests.length === 1);
    h.pool.dispose();
  });
});

describe('review fixes: no stale-token release (M3)', () => {
  for (const reason of ['task-moved', 'goal-closed'] as const) {
    test(`${reason}: the run ends without a "release failed" warning`, async () => {
      const log = makeLogger();
      const h = makePool({}, { deps: { logger: log.logger } });
      const t = addTask('b1', 'g-aaaaaaaa', 'one');
      const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
      const runId = (r as { runId: string }).runId;
      await until(() => h.requests.length === 1);
      // The move / the closure released the claim already.
      const tok = tasks('b1').get(t)?.claim?.token as string;
      tasks('b1').apply([{ op: 'release', id: t, token: tok, lane: 'todo' }], {
        actor: 'operator',
      });
      expect(h.pool.stop(runId, reason)).toBe(true);
      await until(() => h.pool.get(runId)?.status === 'stopped');
      expect(log.warns.filter((w) => w.includes('release failed'))).toEqual([]);
      h.pool.dispose();
    });
  }
});

describe('integration re-review: asks of a run that ended (N2)', () => {
  test('a step that asks and then reports done withdraws the question', async () => {
    const log = makeLogger();
    const ask = new AskHumanStore(log.logger, join(root, 'ask-human'));
    const perms = new AskPermissionStore(log.logger, join(root, 'ask-permission'));
    const h = makePool(
      {},
      {
        tool: (name, args, req) => {
          const runId = req.attribution.runId as string;
          if (name === 'ask_human') {
            const q = ask.ask('b1', 0, String(args.question), undefined, Date.now(), { runId });
            q.promise.catch(() => {});
            return { success: true, content: `Question sent (id ${q.id}) — the run will pause.` };
          }
          if (name === 'ask_permission') {
            const p = perms.request('b1', 'exec', 'deploy', 'd', 'normal', { runId });
            p.promise.catch(() => {});
            return {
              success: true,
              content: `Permission request sent (id ${p.id}, exec on deploy)`,
            };
          }
          return { success: true, content: 'ok' };
        },
        deps: {
          withdrawRunAsks: withdrawRunAsksFrom({
            askHumanStore: ask,
            askPermissionStore: perms,
          } as never),
        },
      }
    );
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, [
      [
        { name: 'ask_human', args: { question: 'Tone?' } },
        { name: 'ask_permission', args: { action: 'exec', resource: 'deploy' } },
        done('finished anyway'),
      ],
    ]);
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => h.pool.get(runId)?.status === 'done');
    expect(ask.getPendingForBot('b1')).toEqual([]);
    expect(perms.getPendingForBot('b1')).toEqual([]);
    h.pool.dispose();
  });

  test('every run end calls the withdraw dep with the run id', async () => {
    const withdrawn: string[] = [];
    const h = makePool({}, { deps: { withdrawRunAsks: (id) => withdrawn.push(id) } });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, ['error']);
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => h.pool.get(runId)?.status === 'failed');
    expect(withdrawn).toEqual([runId]);
    h.pool.dispose();
  });
});

describe('integration re-review: refused calls do not block a resume (N3)', () => {
  const journalTool = (runId: string, extra: Record<string, unknown>) =>
    new WorkerRunStore(join(root, 'data')).appendJournal('b1', runId, {
      ts: new Date(clock).toISOString(),
      runId,
      kind: 'tool',
      n: 1,
      name: 'exec',
      ok: false,
      sideEffect: 'external',
      target: 'deploy.sh',
      ...extra,
    } as JournalEntry);

  for (const failureKind of ['approval-pending', 'blocked', 'scope', 'policy', 'aborted']) {
    test(`an external call refused as ${failureKind} is not treated as done`, async () => {
      const a = makePool();
      const t = addTask('b1', 'g-aaaaaaaa', 'one');
      a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
      await until(() => a.requests.length === 1);
      const runId = a.pool.list('b1')[0].runId;
      journalTool(runId, { failureKind });
      await a.pool.abortAll('shutdown');
      a.pool.dispose();

      const b = makePool();
      b.scripts.set(t, [[done()]]);
      b.pool.recover();
      await until(() => b.pool.get(runId)?.status === 'done');
      b.pool.dispose();
    });
  }

  test('an external call that failed while running still blocks the resume', async () => {
    const a = makePool();
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => a.requests.length === 1);
    const runId = a.pool.list('b1')[0].runId;
    journalTool(runId, { failureKind: 'error' });
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
    const b = makePool();
    b.pool.recover();
    expect(b.pool.get(runId)?.status).toBe('blocked');
    b.pool.dispose();
  });
});

describe('integration re-review: a clean stop costs no attempt (N4)', () => {
  test('two restarts mid-step (no tool in flight) never fail the run', async () => {
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    const a = makePool({ maxAttempts: 2 });
    a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => a.requests.length === 1);
    const runId = a.pool.list('b1')[0].runId;
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
    const b = makePool({ maxAttempts: 2 });
    b.pool.recover();
    await until(() => b.requests.length === 1);
    await b.pool.abortAll('shutdown');
    b.pool.dispose();
    const c = makePool({ maxAttempts: 2 });
    c.scripts.set(t, [[done()]]);
    c.pool.recover();
    await until(() => c.pool.get(runId)?.status === 'done');
    expect(c.pool.get(runId)?.attempt).toBe(1);
    c.pool.dispose();
  });

  test('a crash mid-step (no clean stop) still uses an attempt', async () => {
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    const a = makePool();
    a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => a.requests.length === 1);
    const runId = a.pool.list('b1')[0].runId;
    // The process dies: runs.json still says `running`.
    const b = makePool();
    b.scripts.set(t, [[done()]]);
    b.pool.recover();
    await until(() => b.pool.get(runId)?.status === 'done');
    expect(b.pool.get(runId)?.attempt).toBe(2);
    b.pool.dispose();
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
  });

  test('a clean stop with a tool in flight uses an attempt', async () => {
    const ran: string[] = [];
    const a = makePool(
      {},
      {
        tool: async (name, _args, req) => {
          ran.push(name);
          await new Promise<void>((resolve) => {
            if (req.signal.aborted) resolve();
            else req.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { success: false, content: 'aborted' };
        },
      }
    );
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    a.scripts.set(t, [[{ name: 'web_search', args: { q: 'x' } }, progress()]]);
    a.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    await until(() => ran.length === 1);
    const runId = a.pool.list('b1')[0].runId;
    await a.pool.abortAll('shutdown');
    a.pool.dispose();
    const b = makePool();
    b.scripts.set(t, [[done()]]);
    b.pool.recover();
    await until(() => b.pool.get(runId)?.status === 'done');
    expect(b.pool.get(runId)?.attempt).toBe(2);
    b.pool.dispose();
  });
});

describe('integration re-review: a stopped bot does not hold its tasks (N5)', () => {
  test('claims of a stopped bot are not renewed; on expiry the task goes back to To do', async () => {
    const running = { b1: true };
    const h = makePool(
      { claimTtlMs: 60_000 },
      { deps: { isBotRunning: (b) => running[b as 'b1'] ?? false } }
    );
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => h.requests.length === 1);
    running.b1 = false;
    h.pool.stop(runId, 'shutdown');
    await until(() => h.pool.get(runId)?.status === 'interrupted');
    const before = h.opsLog.length;
    clock += 30_000;
    h.pool.sweep();
    expect(h.opsLog.slice(before).filter((o) => o.startsWith('renew'))).toEqual([]);
    expect(h.pool.get(runId)?.status).toBe('interrupted');
    clock += 31_000;
    h.pool.sweep();
    const ended = h.pool.get(runId);
    expect(ended?.status).toBe('stopped');
    expect(ended?.outcome).toMatchObject({ kind: 'interrupted', note: 'bot stopped' });
    const task = tasks('b1').get(t);
    expect(task?.claim).toBeUndefined();
    expect(task?.lane).toBe('todo');
    expect(task?.note).toBe('bot stopped');
    h.pool.dispose();
  });
});

describe('integration re-review: a paused bot is not resumed by the sweep (N6)', () => {
  test('pause, then stop: the sweep leaves the run alone until kick', async () => {
    const h = makePool({}, { deps: { isBotRunning: () => true } });
    const t = addTask('b1', 'g-aaaaaaaa', 'one');
    h.scripts.set(t, ['hang', [done('resumed')]]);
    const [r] = h.pool.dispatch({ botId: 'b1', taskIds: [t], cycleId: null });
    const runId = (r as { runId: string }).runId;
    await until(() => h.requests.length === 1);
    h.pool.pause('b1');
    h.pool.stop(runId, 'shutdown');
    await until(() => h.pool.get(runId)?.status === 'interrupted');
    // The bot is still in runningBots (cleanupBot has not run yet).
    h.pool.sweep();
    await settle();
    expect(h.pool.get(runId)?.status).toBe('interrupted');
    expect(h.requests).toHaveLength(1);
    h.pool.kick('b1');
    await until(() => h.pool.get(runId)?.status === 'done');
    h.pool.dispose();
  });
});

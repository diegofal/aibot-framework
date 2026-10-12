import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import { groupJournalSteps, workersRoutes } from '../../../src/web/routes/workers';
import type { CycleReader } from '../../../src/why/cycle-index';
import { WhySchema } from '../../../src/why/types';
import type { JournalEntry } from '../../../src/workers/types';
import { type FakePool, createFakePool, makeRun } from '../../helpers/fake-worker-pool';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

const config = {
  bots: [
    { id: 'b1', name: 'Bot One', tenantId: 't1' },
    { id: 'b2', name: 'Bot Two', tenantId: 't2' },
  ],
} as unknown as Config;

function makeApp(pool: FakePool | undefined, tenantId?: string, readCycles?: CycleReader) {
  const app = new Hono();
  if (tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  app.route(
    '/api',
    workersRoutes({ config, logger: noopLogger, workerPool: () => pool, readCycles })
  );
  return app;
}

const post = (app: Hono, path: string) => app.request(path, { method: 'POST' });

function fleetPool() {
  return createFakePool([
    makeRun({ runId: 'r-1', botId: 'b1' }),
    makeRun({ runId: 'r-2', botId: 'b1', status: 'done', endedAt: '2026-10-12T09:30:00.000Z' }),
    makeRun({ runId: 'r-3', botId: 'b2', status: 'waiting' }),
  ]);
}

describe('GET /api/agents/:id/workers', () => {
  it('lists active and recently ended runs of the bot, without claim tokens', async () => {
    const pool = fleetPool();
    pool.runs[0] = { ...pool.runs[0], claimToken: 'secret' } as never;
    const res = await makeApp(pool).request('/api/agents/b1/workers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.runs.map((r: { runId: string }) => r.runId)).toEqual(['r-1', 'r-2']);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('is { enabled: false, runs: [] } without a pool', async () => {
    const body = await (await makeApp(undefined).request('/api/agents/b1/workers')).json();
    expect(body).toEqual({ enabled: false, runs: [] });
  });

  it('is { enabled: false, runs: [] } when workers are off for the bot', async () => {
    const pool = fleetPool();
    pool.enabled = false;
    const body = await (await makeApp(pool).request('/api/agents/b1/workers')).json();
    expect(body).toEqual({ enabled: false, runs: [] });
  });

  it('404 for an unknown bot or another tenant’s bot', async () => {
    const pool = fleetPool();
    expect((await makeApp(pool).request('/api/agents/nope/workers')).status).toBe(404);
    expect((await makeApp(pool, 't1').request('/api/agents/b2/workers')).status).toBe(404);
  });
});

describe('GET /api/workers (fleet)', () => {
  it('lists runs of every bot the caller can see', async () => {
    const pool = fleetPool();
    const all = await (await makeApp(pool).request('/api/workers')).json();
    expect(all.enabled).toBe(true);
    expect(all.runs.map((r: { runId: string }) => r.runId).sort()).toEqual(['r-1', 'r-2', 'r-3']);
    const t1 = await (await makeApp(pool, 't1').request('/api/workers')).json();
    expect(t1.runs.map((r: { runId: string }) => r.runId)).toEqual(['r-1', 'r-2']);
  });

  it('drops runs of bots no longer in the config', async () => {
    const pool = fleetPool();
    pool.runs.push(makeRun({ runId: 'r-9', botId: 'ghost' }));
    const all = await (await makeApp(pool).request('/api/workers')).json();
    expect(all.runs.map((r: { runId: string }) => r.runId)).not.toContain('r-9');
  });

  it('is { enabled: false, runs: [] } without a pool', async () => {
    expect(await (await makeApp(undefined).request('/api/workers')).json()).toEqual({
      enabled: false,
      runs: [],
    });
  });
});

describe('GET /api/workers/:runId', () => {
  it('returns the run, its journal and the steps grouped', async () => {
    const pool = fleetPool();
    pool.journals['r-1'] = [
      { ts: 'a', runId: 'r-1', kind: 'run-start', attempt: 1 },
      { ts: 'b', runId: 'r-1', kind: 'step-start', n: 1 },
      {
        ts: 'c',
        runId: 'r-1',
        kind: 'tool',
        n: 1,
        name: 'web_search',
        ok: true,
        sideEffect: 'read',
      },
    ];
    const res = await makeApp(pool).request('/api/workers/r-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.runId).toBe('r-1');
    expect(body.journal).toHaveLength(3);
    expect(body.steps).toMatchObject([
      { n: 1, startedAt: 'b', toolCalls: [{ name: 'web_search' }] },
    ]);
  });

  it('attaches the why of the run, with the dispatching cycle from the cycle log (C22)', async () => {
    const pool = fleetPool();
    const reads: Array<[string, number, number]> = [];
    const readCycles: CycleReader = (botId, since, until) => {
      reads.push([botId, since, until]);
      return [
        {
          cycleId: 'c-1',
          startedAt: '2026-10-12T08:59:00.000Z',
          endedAt: '2026-10-12T09:01:00.000Z',
          planSummary: 'Hand the room booking to a worker',
        },
      ];
    };
    const body = await (
      await makeApp(pool, undefined, readCycles).request('/api/workers/r-1')
    ).json();
    expect(WhySchema.safeParse(body.why).success).toBe(true);
    expect(body.why.by).toBe('agent');
    expect(body.why.cycle).toMatchObject({ id: 'c-1', plan: 'Hand the room booking to a worker' });
    expect(reads.map((r) => r[0])).toEqual(['b1']);
  });

  it('the why survives a cycle log that cannot be read (the cycle has no plan)', async () => {
    const pool = fleetPool();
    const readCycles: CycleReader = () => {
      throw new Error('disk');
    };
    const res = await makeApp(pool, undefined, readCycles).request('/api/workers/r-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.why.cycle).toMatchObject({ id: 'c-1' });
    expect(body.why.missing).toContain('cycle log');
    const bare = await (await makeApp(pool).request('/api/workers/r-1')).json();
    expect(bare.why.cycle).toMatchObject({ id: 'c-1' });
  });

  it('404 for an unknown run, another tenant’s run, or no pool', async () => {
    const pool = fleetPool();
    expect((await makeApp(pool).request('/api/workers/r-x')).status).toBe(404);
    expect((await makeApp(pool, 't1').request('/api/workers/r-3')).status).toBe(404);
    expect((await makeApp(undefined).request('/api/workers/r-1')).status).toBe(404);
  });
});

describe('POST /api/workers/:runId/stop and /retry', () => {
  it('stop aborts an active run as the operator', async () => {
    const pool = fleetPool();
    const res = await post(makeApp(pool), '/api/workers/r-1/stop');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true, runId: 'r-1' });
    expect(pool.stops).toEqual([{ runId: 'r-1', reason: 'operator' }]);
  });

  it('stop of an ended run is 409', async () => {
    const res = await post(makeApp(fleetPool()), '/api/workers/r-2/stop');
    expect(res.status).toBe(409);
  });

  it('retry starts a new attempt of an ended run', async () => {
    const pool = fleetPool();
    const res = await post(makeApp(pool), '/api/workers/r-2/retry');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, runId: 'r-2-retry' });
    expect(pool.retries).toEqual(['r-2']);
  });

  it('a refused retry is 409 with the reason', async () => {
    const res = await post(makeApp(fleetPool()), '/api/workers/r-1/retry');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'claimed' });
  });

  it('404 across tenants and without a pool; nothing is stopped', async () => {
    const pool = fleetPool();
    expect((await post(makeApp(pool, 't1'), '/api/workers/r-3/stop')).status).toBe(404);
    expect((await post(makeApp(pool, 't1'), '/api/workers/r-3/retry')).status).toBe(404);
    expect((await post(makeApp(undefined), '/api/workers/r-1/stop')).status).toBe(404);
    expect(pool.stops).toEqual([]);
  });
});

describe('groupJournalSteps', () => {
  const j = (e: Record<string, unknown>) => ({ ts: 't', runId: 'r', ...e }) as JournalEntry;

  it('folds step-start, tools, report and step-end into one record per step', () => {
    const steps = groupJournalSteps([
      j({ kind: 'run-start', attempt: 1 }),
      j({ kind: 'step-start', n: 1, ts: '1' }),
      j({
        kind: 'tool',
        n: 1,
        name: 'web_fetch',
        target: 'acme.com/about',
        ok: true,
        sideEffect: 'read',
      }),
      j({ kind: 'report', n: 1, report: { kind: 'progress', note: 'Found Acme' } }),
      j({ kind: 'step-end', n: 1, ts: '2', summary: 'Found Acme · web_fetch' }),
      j({ kind: 'step-start', n: 2, ts: '3' }),
      j({ kind: 'tool', n: 2, name: 'exec', ok: false, sideEffect: 'external' }),
    ]);
    expect(steps).toEqual([
      {
        n: 1,
        startedAt: '1',
        endedAt: '2',
        summary: 'Found Acme · web_fetch',
        report: { kind: 'progress', note: 'Found Acme' },
        toolCalls: [{ name: 'web_fetch', target: 'acme.com/about', ok: true, sideEffect: 'read' }],
      },
      {
        n: 2,
        startedAt: '3',
        toolCalls: [{ name: 'exec', ok: false, sideEffect: 'external' }],
      },
    ]);
  });

  it('keeps a step error and tolerates rows of a step it never saw start', () => {
    const steps = groupJournalSteps([
      j({ kind: 'tool', n: 3, name: 'x', ok: true, sideEffect: 'read', ts: '9' }),
      j({ kind: 'step-end', n: 3, summary: '', error: 'timeout', ts: '10' }),
    ]);
    expect(steps).toEqual([
      {
        n: 3,
        startedAt: '9',
        endedAt: '10',
        error: 'timeout',
        toolCalls: [{ name: 'x', ok: true, sideEffect: 'read' }],
      },
    ]);
  });

  it('is [] for an empty journal', () => {
    expect(groupJournalSteps([])).toEqual([]);
  });
});

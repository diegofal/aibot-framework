import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import { cronRoutes } from '../../../src/web/routes/cron';

// Row 16 of docs/plans/why-everywhere-plan.md: the dashboard path stamps the
// operator as creator; the job detail carries a `why` for the job and for
// each run.

const agentJob = {
  id: 'j1',
  name: 'Brief',
  enabled: true,
  createdAtMs: Date.UTC(2026, 9, 11, 12),
  updatedAtMs: 0,
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  payload: { kind: 'instruction', text: 'Brief me', chatId: 1, botId: 'b1' },
  state: { consecutiveErrors: 0 },
  createdBy: { kind: 'agent', botId: 'b1', cycleId: 'c1', goalId: 'g1' },
};

const runs = [
  {
    ts: Date.UTC(2026, 9, 12, 9, 0, 2),
    jobId: 'j1',
    action: 'finished',
    status: 'ok',
    output: 'Here you go',
    runAtMs: Date.UTC(2026, 9, 12, 9),
    durationMs: 2000,
  },
];

function makeApp(readCycles?: (botId: string, since: number, until: number) => unknown[]) {
  const cronService = {
    list: mock(async () => [agentJob]),
    runs: mock(async () => runs),
    add: mock(async (input: Record<string, unknown>) => ({ id: 'new', ...input })),
  };
  const config = { bots: [{ id: 'b1' }] } as unknown as Config;
  const app = new Hono();
  app.route(
    '/api/cron',
    cronRoutes({ cronService: cronService as never, config, readCycles: readCycles as never })
  );
  return { app, cronService };
}

describe('cron routes: why', () => {
  test('POST stamps the operator, whatever the body claims', async () => {
    const { app, cronService } = makeApp();
    const res = await app.request('/api/cron', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'x',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        payload: { kind: 'instruction', text: 't', chatId: 1, botId: 'b1' },
        createdBy: { kind: 'agent', botId: 'b1', cycleId: 'forged' },
      }),
    });
    expect(res.status).toBe(201);
    expect(cronService.add.mock.calls[0][0].createdBy).toEqual({ kind: 'operator' });
  });

  test('GET /:id: the job why (cycle plan and goal from the log) and one why per run', async () => {
    const readCycles = mock(() => [
      {
        cycleId: 'c1',
        startedAt: '2026-10-11T11:59:00Z',
        endedAt: '2026-10-11T12:05:00Z',
        planSummary: 'Set up a brief',
        goalId: 'g1',
        goalTitle: 'Keep informed',
      },
    ]);
    const { app } = makeApp(readCycles);
    const body = await (await app.request('/api/cron/j1')).json();
    expect(body.why.by).toBe('agent');
    expect(body.why.cycle.plan).toBe('Set up a brief');
    expect(body.why.goal).toEqual({ id: 'g1', title: 'Keep informed' });
    expect(body.runs[0].why.what).toBe('A run of "Brief"');
    expect(body.runs[0].why.outcome).toBe('Ran fine in 2.0 s. Output: "Here you go"');
    expect(readCycles).toHaveBeenCalledTimes(1);
  });

  test('GET /:id without a cycle reader still explains the job', async () => {
    const { app } = makeApp();
    const body = await (await app.request('/api/cron/j1')).json();
    expect(body.why.cycle).toEqual({ id: 'c1', botId: 'b1' });
    expect(body.why.missing).toContain('cycle log has no row');
  });

  test('GET / lists jobs with their why', async () => {
    const { app } = makeApp();
    const body = await (await app.request('/api/cron')).json();
    expect(body[0].why.what).toBe('A scheduled job the agent set up');
  });

  test('GET / carries the next 7 days of runs for enabled jobs, none for paused ones', async () => {
    const paused = { ...agentJob, id: 'j2', enabled: false };
    const { app, cronService } = makeApp();
    cronService.list.mockImplementation(async () => [agentJob, paused]);
    const body = (await (await app.request('/api/cron')).json()) as Array<{
      id: string;
      upcoming: number[];
    }>;
    const byId = Object.fromEntries(body.map((j) => [j.id, j.upcoming]));
    expect(byId.j1.length).toBe(7);
    expect(byId.j1.every((t, i, a) => i === 0 || t > a[i - 1])).toBe(true);
    expect(byId.j2).toEqual([]);
  });
});

// Only the instance operator's dashboard stamps `operator` (the trust that
// lets a job reach personal data, src/cron/trust.ts); a tenant API caller never.
describe('cron routes: who created a job, under multi-tenant', () => {
  function tenantApp(jobs: Record<string, unknown>[] = []) {
    const cronService = {
      list: mock(async () => jobs),
      add: mock(async (input: Record<string, unknown>) => ({ id: 'new', ...input })),
      update: mock(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
    };
    const config = {
      bots: [
        { id: 'tenant-bot', tenantId: 'acme' },
        { id: 'other-bot', tenantId: 'globex' },
      ],
    } as unknown as Config;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: 'acme' } as never);
      await next();
    });
    app.route('/api/cron', cronRoutes({ cronService: cronService as never, config }));
    return { app, cronService };
  }

  test('POST from a tenant stamps the tenant, never the operator', async () => {
    const { app, cronService } = tenantApp();
    const res = await app.request('/api/cron', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'x',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        payload: { kind: 'instruction', text: 't', chatId: 1, botId: 'tenant-bot' },
      }),
    });
    expect(res.status).toBe(201);
    expect(cronService.add.mock.calls[0][0].createdBy).toEqual({
      kind: 'tenant',
      tenantId: 'acme',
    });
  });

  test("PATCH cannot move a job to another tenant's bot", async () => {
    const { app, cronService } = tenantApp([
      { id: 'j1', payload: { kind: 'instruction', text: 't', chatId: 1, botId: 'tenant-bot' } },
    ]);
    const res = await app.request('/api/cron/j1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { kind: 'instruction', botId: 'other-bot' } }),
    });
    expect(res.status).toBe(404);
    expect(cronService.update).not.toHaveBeenCalled();
  });

  test('PATCH within the tenant still works', async () => {
    const { app, cronService } = tenantApp([
      { id: 'j1', payload: { kind: 'instruction', text: 't', chatId: 1, botId: 'tenant-bot' } },
    ]);
    const res = await app.request('/api/cron/j1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { kind: 'instruction', text: 'new' } }),
    });
    expect(res.status).toBe(200);
    expect(cronService.update).toHaveBeenCalledTimes(1);
  });
});

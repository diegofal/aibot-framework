import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import { cronRoutes } from '../../../src/web/routes/cron';

// The Cron Jobs page listed every failed nightly-reflection job with no way
// to retry them together — an operator had to click Run on each one. This
// endpoint finds every enabled job whose last run errored and force-runs it.

function job(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: overrides.id ?? 'job-1',
    name: overrides.name ?? 'Some job',
    enabled: overrides.enabled ?? true,
    payload: overrides.payload ?? { kind: 'skillJob', skillId: 'reflection', jobId: 'x' },
    schedule: { kind: 'cron', expr: '30 3 * * *' },
    createdAtMs: 0,
    updatedAtMs: 0,
    state: { consecutiveErrors: 1, lastStatus: 'error', ...(overrides.state as object) },
    ...overrides,
  };
}

function makeApp(jobs: unknown[], runImpl?: (id: string) => Promise<unknown>) {
  const cronService = {
    list: mock(async () => jobs),
    run: mock(runImpl ?? (async () => ({ ok: true, ran: true }))),
  };
  const config = { bots: [] } as unknown as Config;
  const app = new Hono();
  app.route('/api/cron', cronRoutes({ cronService: cronService as never, config }));
  return { app, cronService };
}

describe('POST /api/cron/rerun-failed', () => {
  test('force-runs every enabled job whose last status is error', async () => {
    const jobs = [
      job({ id: 'a', state: { lastStatus: 'error' } }),
      job({ id: 'b', state: { lastStatus: 'ok' } }),
      job({ id: 'c', state: { lastStatus: 'error' } }),
      job({ id: 'd', enabled: false, state: { lastStatus: 'error' } }),
    ];
    const { app, cronService } = makeApp(jobs);

    const res = await app.request('/api/cron/rerun-failed', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(cronService.run).toHaveBeenCalledTimes(2);
    const ranIds = cronService.run.mock.calls.map((c) => c[0]);
    expect(ranIds.sort()).toEqual(['a', 'c']);
    expect(body.attempted).toBe(2);
    expect(body.results.map((r: { id: string }) => r.id).sort()).toEqual(['a', 'c']);
  });

  test('does nothing when no job is failing', async () => {
    const jobs = [job({ id: 'a', state: { lastStatus: 'ok' } })];
    const { app, cronService } = makeApp(jobs);

    const res = await app.request('/api/cron/rerun-failed', { method: 'POST' });
    const body = await res.json();

    expect(cronService.run).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, attempted: 0, results: [] });
  });

  test('one job throwing does not stop the rest from running', async () => {
    const jobs = [
      job({ id: 'a', state: { lastStatus: 'error' } }),
      job({ id: 'b', state: { lastStatus: 'error' } }),
    ];
    const { app } = makeApp(jobs, async (id: string) => {
      if (id === 'a') throw new Error('boom');
      return { ok: true, ran: true };
    });

    const res = await app.request('/api/cron/rerun-failed', { method: 'POST' });
    const body = await res.json();

    expect(body.attempted).toBe(2);
    const a = body.results.find((r: { id: string }) => r.id === 'a');
    const b = body.results.find((r: { id: string }) => r.id === 'b');
    expect(a.ran).toBe(false);
    expect(a.reason).toContain('boom');
    expect(b.ran).toBe(true);
  });

  test('a job that is already-running is reported, not treated as a hard failure', async () => {
    const jobs = [job({ id: 'a', state: { lastStatus: 'error' } })];
    const { app } = makeApp(jobs, async () => ({
      ok: true,
      ran: false,
      reason: 'already-running',
    }));

    const res = await app.request('/api/cron/rerun-failed', { method: 'POST' });
    const body = await res.json();

    expect(body.results[0]).toMatchObject({ id: 'a', ran: false, reason: 'already-running' });
  });

  test('tenant scoping: only reruns failed jobs belonging to the tenant’s bots', async () => {
    const jobs = [
      job({
        id: 'mine',
        payload: { kind: 'instruction', botId: 'tenant-bot' },
        state: { lastStatus: 'error' },
      }),
      job({
        id: 'theirs',
        payload: { kind: 'instruction', botId: 'other-bot' },
        state: { lastStatus: 'error' },
      }),
    ];
    const cronService = {
      list: mock(async () => jobs),
      run: mock(async () => ({ ok: true, ran: true })),
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

    const res = await app.request('/api/cron/rerun-failed', { method: 'POST' });
    const body = await res.json();

    expect(body.attempted).toBe(1);
    expect(body.results[0].id).toBe('mine');
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { hygieneRoutes } from '../../src/web/routes/hygiene';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';
import { makeBot, makeConfig, noopLogger, writeFile } from './helpers';

let root: string;

beforeEach(() => {
  root = createTempDir('hygiene-routes');
});

afterEach(() => {
  removeTempDir(root);
});

function makeApp(opts: { tenantId?: string; bots?: ReturnType<typeof makeBot>[] } = {}) {
  const bots = opts.bots ?? [
    makeBot({ id: 'bot1', tenantId: 'tenant-A' } as any),
    makeBot({ id: 'bot2', tenantId: 'tenant-B' } as any),
  ];
  const config = makeConfig(root, bots);
  const app = new Hono();
  if (opts.tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant' as never, { tenantId: opts.tenantId, apiKey: 'k', plan: 'pro' } as never);
      await next();
    });
  }
  app.route(
    '/api/hygiene',
    hygieneRoutes({ config, logger: noopLogger, botManager: { isRunning: () => false } as any })
  );
  return app;
}

function post(app: Hono, body: unknown) {
  return app.request('/api/hygiene/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/hygiene/routines', () => {
  test('lists routines with the contract shape', async () => {
    const res = await makeApp().request('/api/hygiene/routines');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toEqual({
      id: 'goal-lint',
      name: expect.any(String),
      description: expect.any(String),
      scope: 'bot',
      canApply: true,
    });
  });
});

describe('POST /api/hygiene/run', () => {
  test('previews a bot routine and returns a HygieneRun', async () => {
    writeFile(
      join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul', 'GOALS.md'),
      '## Active Goals\n- [ ] X\n  - status: archived\n  - priority: low\n'
    );
    const res = await post(makeApp(), { routine: 'goal-lint', botId: 'bot1' });
    expect(res.status).toBe(200);
    const run = await res.json();
    expect(run).toMatchObject({ routine: 'goal-lint', botId: 'bot1', dryRun: true });
    expect(run.findings[0].kind).toBe('archived-in-active');
    expect(run.applied).toEqual([]);
    expect(run.skipped).toEqual([]);
    expect(run.backups).toEqual([]);
  });

  test('apply=true runs fixes and the run shows up in history', async () => {
    writeFile(
      join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul', 'GOALS.md'),
      '## Active Goals\n- [ ] X\n  - status: archived\n  - priority: low\n'
    );
    const app = makeApp();
    const res = await post(app, { routine: 'goal-lint', botId: 'bot1', apply: true });
    const run = await res.json();
    expect(run.dryRun).toBe(false);
    expect(run.applied).toHaveLength(1);
    expect(existsSync(run.backups[0])).toBe(true);

    const hist = await (await app.request('/api/hygiene/history?botId=bot1')).json();
    expect(hist).toHaveLength(1);
    expect(hist[0].runId).toBe(run.runId);
  });

  test('400 on missing/unknown routine or missing botId', async () => {
    const app = makeApp();
    expect((await post(app, {})).status).toBe(400);
    expect((await post(app, { routine: 'nope' })).status).toBe(400);
    expect((await post(app, { routine: 'goal-lint' })).status).toBe(400);
  });

  test('404 for an unknown bot or a bot from another tenant', async () => {
    expect((await post(makeApp(), { routine: 'goal-lint', botId: 'zzz' })).status).toBe(404);
    expect(
      (await post(makeApp({ tenantId: 'tenant-A' }), { routine: 'goal-lint', botId: 'bot2' }))
        .status
    ).toBe(404);
    expect(
      (await post(makeApp({ tenantId: 'tenant-A' }), { routine: 'goal-lint', botId: 'bot1' }))
        .status
    ).toBe(200);
  });

  test('fleet routines are admin-only', async () => {
    expect(
      (await post(makeApp({ tenantId: 'tenant-A' }), { routine: 'data-cleanup' })).status
    ).toBe(403);
    expect(
      (await post(makeApp({ tenantId: '__admin__' }), { routine: 'data-cleanup' })).status
    ).toBe(200);
    expect((await post(makeApp(), { routine: 'data-cleanup' })).status).toBe(200);
  });

  test('all: tenants get their bots only and no fleet findings; admin gets everything', async () => {
    writeFile(
      join(root, 'data', 'tenants', '__admin__', 'bots', 'bot2', 'soul', 'MEMORY.md'),
      'mail a@b.co\n'
    );
    writeFile(join(root, 'data', 'karma', 'ghost', 'events.jsonl'), '{}');
    const tenantRun = await (
      await post(makeApp({ tenantId: 'tenant-A' }), { routine: 'all' })
    ).json();
    expect(tenantRun.findings.filter((f: any) => f.botId === 'bot2')).toHaveLength(0);
    expect(tenantRun.findings.filter((f: any) => f.kind === 'orphan-karma-dir')).toHaveLength(0);

    const adminRun = await (await post(makeApp(), { routine: 'all' })).json();
    expect(adminRun.findings.some((f: any) => f.botId === 'bot2' && f.kind === 'pii')).toBe(true);
    expect(adminRun.findings.some((f: any) => f.kind === 'orphan-karma-dir')).toBe(true);
  });

  test('options are forwarded to the routine', async () => {
    const workDir = join(root, 'productions', 'bot1');
    writeFile(
      join(workDir, '01_old.md'),
      'content content content content content content content'
    );
    writeFile(
      join(workDir, 'changelog.jsonl'),
      `${JSON.stringify({
        id: 'e1',
        timestamp: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: '01_old.md',
        action: 'create',
        description: '',
        size: 1,
        trackOnly: false,
      })}\n`
    );
    const run = await (
      await post(makeApp(), {
        routine: 'productions-triage',
        botId: 'bot1',
        apply: true,
        options: { archiveStale: true },
      })
    ).json();
    expect(run.applied.map((a: any) => a.action)).toEqual(['archive']);
    expect(existsSync(join(workDir, 'archived', '01_old.md'))).toBe(true);
  });

  test('rejects a non-object body', async () => {
    const res = await makeApp().request('/api/hygiene/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'nope',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/hygiene/history', () => {
  test('tenants only see runs for their bots; admin sees fleet runs too', async () => {
    const admin = makeApp();
    await post(admin, { routine: 'goal-lint', botId: 'bot1' });
    await post(admin, { routine: 'goal-lint', botId: 'bot2' });
    await post(admin, { routine: 'data-cleanup' });

    const all = await (await admin.request('/api/hygiene/history')).json();
    expect(all.map((r: any) => r.routine)).toEqual(['data-cleanup', 'goal-lint', 'goal-lint']);

    const tenant = await (
      await makeApp({ tenantId: 'tenant-A' }).request('/api/hygiene/history')
    ).json();
    expect(tenant).toHaveLength(1);
    expect(tenant[0].botId).toBe('bot1');

    const denied = await makeApp({ tenantId: 'tenant-A' }).request(
      '/api/hygiene/history?botId=bot2'
    );
    expect(denied.status).toBe(404);

    const limited = await (await admin.request('/api/hygiene/history?limit=1')).json();
    expect(limited).toHaveLength(1);
    expect(
      readFileSync(join(root, 'data', 'hygiene', 'runs.jsonl'), 'utf-8')
        .trim()
        .split('\n')
    ).toHaveLength(3);
  });
});

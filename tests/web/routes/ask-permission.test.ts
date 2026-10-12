import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { askPermissionRoutes } from '../../../src/web/routes/ask-permission';

function makeLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: () => makeLogger(),
  } as any;
}

function makeBotManager(overrides: Record<string, any> = {}) {
  return {
    getPermissionsPending: mock(() => overrides.pending ?? []),
    getPermissionsCount: mock(() => overrides.count ?? 0),
    approvePermission: mock(
      (id: string, note?: string) => overrides.approveResult ?? id === 'valid-id'
    ),
    denyPermission: mock((id: string, note?: string) => overrides.denyResult ?? id === 'valid-id'),
    requeuePermission: mock((id: string) => overrides.requeueResult ?? id === 'valid-id'),
    getPermissionsHistory: mock((limit?: number) => overrides.history ?? []),
    getPermissionHistoryById: mock((id: string) => overrides.historyById?.[id] ?? undefined),
  } as any;
}

function createApp(botManager: any) {
  const app = new Hono();
  app.route('/api/ask-permission', askPermissionRoutes({ botManager, logger: makeLogger() }));
  return app;
}

describe('ask-permission routes', () => {
  test('GET / returns empty list', async () => {
    const app = createApp(makeBotManager());
    const res = await app.request('/api/ask-permission');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.requests).toEqual([]);
    expect(data.totalCount).toBe(0);
  });

  test('GET / returns pending requests', async () => {
    const pending = [
      {
        id: '1',
        botId: 'bot1',
        botName: 'TestBot',
        action: 'file_write',
        resource: '/tmp/x',
        description: 'test',
        urgency: 'normal',
        status: 'pending',
        createdAt: Date.now(),
        timeoutMs: 60000,
        remainingMs: 55000,
      },
    ];
    const app = createApp(makeBotManager({ pending }));
    const res = await app.request('/api/ask-permission');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.requests).toHaveLength(1);
    expect(data.requests[0].action).toBe('file_write');
    expect(data.totalCount).toBe(1);
  });

  test('GET /count returns 0', async () => {
    const app = createApp(makeBotManager());
    const res = await app.request('/api/ask-permission/count');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.count).toBe(0);
  });

  test('GET /count returns correct count', async () => {
    const app = createApp(makeBotManager({ count: 3 }));
    const res = await app.request('/api/ask-permission/count');
    const data = await res.json();

    expect(data.count).toBe(3);
  });

  test('POST /:id/approve works', async () => {
    const bm = makeBotManager();
    const app = createApp(bm);
    const res = await app.request('/api/ask-permission/valid-id/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Looks good' }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(bm.approvePermission).toHaveBeenCalledWith('valid-id', 'Looks good');
  });

  test('POST /:id/approve without note', async () => {
    const bm = makeBotManager();
    const app = createApp(bm);
    const res = await app.request('/api/ask-permission/valid-id/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(bm.approvePermission).toHaveBeenCalledWith('valid-id', undefined);
  });

  test('POST /:id/deny works with optional note', async () => {
    const bm = makeBotManager();
    const app = createApp(bm);
    const res = await app.request('/api/ask-permission/valid-id/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Too risky' }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(bm.denyPermission).toHaveBeenCalledWith('valid-id', 'Too risky');
  });

  test('POST /:id/approve returns 404 for unknown ID', async () => {
    const bm = makeBotManager();
    const app = createApp(bm);
    const res = await app.request('/api/ask-permission/unknown-id/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not found');
  });

  test('POST /:id/deny returns 404 for unknown ID', async () => {
    const bm = makeBotManager();
    const app = createApp(bm);
    const res = await app.request('/api/ask-permission/unknown-id/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not found');
  });

  test('GET /history returns empty entries', async () => {
    const app = createApp(makeBotManager());
    const res = await app.request('/api/ask-permission/history');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.entries).toEqual([]);
  });

  test('GET /history returns history entries', async () => {
    const history = [
      {
        id: 'h1',
        botId: 'bot1',
        botName: 'TestBot',
        action: 'file_write',
        resource: '/tmp/x',
        description: 'test',
        status: 'approved',
        executionStatus: 'executed',
        resolvedAt: Date.now(),
        executionSummary: 'Done',
      },
    ];
    const app = createApp(makeBotManager({ history }));
    const res = await app.request('/api/ask-permission/history');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].executionStatus).toBe('executed');
  });

  test('GET /history/:id returns found entry', async () => {
    const entry = {
      id: 'h1',
      botId: 'bot1',
      botName: 'TestBot',
      action: 'exec',
      resource: 'cmd',
      description: 'test',
      status: 'approved',
      executionStatus: 'consumed',
      resolvedAt: Date.now(),
    };
    const app = createApp(makeBotManager({ historyById: { h1: entry } }));
    const res = await app.request('/api/ask-permission/history/h1');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.entry.id).toBe('h1');
    expect(data.entry.executionStatus).toBe('consumed');
  });

  test('GET /history/:id returns 404 for unknown', async () => {
    const app = createApp(makeBotManager());
    const res = await app.request('/api/ask-permission/history/unknown');

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not found');
  });

  test('POST /history/:id/requeue returns 200 on success', async () => {
    const bm = makeBotManager();
    const app = createApp(bm);
    const res = await app.request('/api/ask-permission/history/valid-id/requeue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(bm.requeuePermission).toHaveBeenCalledWith('valid-id');
  });

  test('POST /history/:id/requeue returns 404 for unknown/non-requeueable ID', async () => {
    const bm = makeBotManager();
    const app = createApp(bm);
    const res = await app.request('/api/ask-permission/history/unknown-id/requeue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not requeueable');
  });
});

describe('ask-permission routes: why (plan row 14)', () => {
  const T = Date.parse('2026-10-11T12:00:00.000Z');
  const row = {
    cycleId: 'c-1',
    startedAt: '2026-10-11T11:58:00.000Z',
    endedAt: '2026-10-11T12:05:00.000Z',
    planSummary: 'Clean the build',
    goalId: 'g-1',
    goalTitle: 'Ship 2.0',
  };

  function appWithCycles(botManager: any) {
    const reads: string[] = [];
    const app = new Hono();
    app.route(
      '/api/ask-permission',
      askPermissionRoutes({
        botManager,
        logger: makeLogger(),
        readCycles: (botId) => {
          reads.push(botId);
          return [row];
        },
      })
    );
    return { app, reads };
  }

  test('GET / names the cycle, goal and request of each pending item', async () => {
    const { app, reads } = appWithCycles(
      makeBotManager({
        pending: [
          {
            id: '1',
            botId: 'bot1',
            action: 'exec',
            resource: 'rm -rf build/',
            description: 'Stale build',
            urgency: 'normal',
            status: 'pending',
            createdAt: T,
            cycleId: 'c-1',
            goalId: 'g-1',
          },
          {
            id: '2',
            botId: 'bot1',
            action: 'exec',
            resource: 'ls',
            description: 'Old one',
            urgency: 'normal',
            status: 'pending',
            createdAt: T,
          },
        ],
      })
    );
    const data = await (await app.request('/api/ask-permission')).json();
    expect(reads).toEqual(['bot1']);
    expect(data.requests[0].why).toMatchObject({
      cycle: { id: 'c-1', botId: 'bot1', plan: 'Clean the build' },
      goal: { id: 'g-1', title: 'Ship 2.0' },
      reason: { text: 'Stale build', source: "Agent's request" },
      outcome: 'Waiting for your decision.',
    });
    expect(data.requests[0].why.missing).toBeUndefined();
    expect(data.requests[1].why.missing).toContain('No record of the cycle that asked');
  });

  test('GET /history uses the execution summary as the outcome', async () => {
    const { app } = appWithCycles(
      makeBotManager({
        history: [
          {
            id: '1',
            botId: 'bot1',
            action: 'exec',
            resource: 'rm -rf build/',
            description: 'Stale build',
            status: 'approved',
            resolvedAt: T,
            executionStatus: 'executed',
            executionSummary: 'Removed 3 files.',
            cycleId: 'c-1',
          },
        ],
      })
    );
    const data = await (await app.request('/api/ask-permission/history')).json();
    expect(data.entries[0].why.outcome).toBe('You approved it and it acted: Removed 3 files.');
    expect(data.entries[0].why.cycle.id).toBe('c-1');
  });
});

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { CuriositySnapshot } from '../../src/bot/curiosity/service';
import type { Direction, Dispatch, FrontierItem } from '../../src/bot/curiosity/types';
import type { BotConfig, Config } from '../../src/config';
import { type CuriosityRouteSource, curiosityRoutes } from '../../src/web/routes/curiosity';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

function dispatch(botId: string, id: string, createdAt: string, extra: Partial<Dispatch> = {}) {
  return {
    id,
    botId,
    createdAt,
    kind: 'insight',
    topic: 'rag',
    hook: `hook ${id}`,
    whyCare: 'why',
    evidence: 'ev',
    action: 'act',
    body: 'body',
    editorScore: 0.8,
    status: 'sent',
    ...extra,
  } as Dispatch;
}

function frontier(id: string): FrontierItem {
  return {
    id,
    question: 'q?',
    whyInteresting: 'why',
    distance: 2,
    surpriseScore: 0.7,
    createdAt: '2026-10-01T00:00:00Z',
    status: 'open',
  };
}

function fakeService() {
  const dispatches: Record<string, Dispatch[]> = {
    b1: [
      dispatch('b1', 'd1', '2026-10-01T10:00:00Z'),
      dispatch('b1', 'd3', '2026-10-03T10:00:00Z', { status: 'held' }),
    ],
    b2: [dispatch('b2', 'd2', '2026-10-02T10:00:00Z', { kind: 'proposal' })],
    b3: [dispatch('b3', 'd9', '2026-10-04T10:00:00Z')],
  };
  const frontierById: Record<string, FrontierItem[]> = { b1: [frontier('f1')] };
  const direction: Record<string, Direction | null> = {
    b1: { at: '2026-10-01T00:00:00Z', summary: 'go', retrospective: 'r', bets: [] },
    b2: null,
  };
  const calls: string[] = [];
  const svc: CuriosityRouteSource = {
    snapshot(botId, opts) {
      calls.push(`snapshot:${botId}:${opts?.dispatchLimit}`);
      if (!dispatches[botId]) return null;
      return {
        botId,
        dispatches: [...dispatches[botId]].reverse(),
      } as unknown as CuriositySnapshot;
    },
    signalDispatch(botId, id, signal) {
      const d = dispatches[botId]?.find((x) => x.id === id);
      if (!d) return null;
      d.signal = signal;
      return d;
    },
    signalFrontier(botId, id, signal) {
      const f = frontierById[botId]?.find((x) => x.id === id);
      if (!f) return null;
      f.operatorSignal = signal;
      return f;
    },
    signalDirection(botId, signal) {
      const d = direction[botId];
      if (!d) return null;
      d.operatorSignal = signal;
      return d;
    },
    storeFor(botId) {
      const list = dispatches[botId];
      if (!list) return null;
      return {
        listDispatches: (limit?: number) => [...list].reverse().slice(0, limit),
      };
    },
  };
  return { svc, calls, dispatches, frontierById, direction };
}

function makeApp(opts: { tenantId?: string } = {}) {
  const fake = fakeService();
  const config = {
    bots: [
      { id: 'b1', name: 'Bot One', tenantId: 't1' },
      { id: 'b2', name: 'Bot Two', tenantId: 't1' },
      { id: 'b3', name: 'Bot Three', tenantId: 't2' },
    ] as BotConfig[],
  } as Config;
  const app = new Hono();
  if (opts.tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: opts.tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  app.route(
    '/api/curiosity',
    curiosityRoutes({
      config,
      botManager: { getCuriosityService: () => fake.svc },
      logger: noopLogger,
      avatarUrlFor: (id) => (id === 'b1' ? '/api/agents/b1/avatar?v=1' : null),
    })
  );
  return { app, ...fake };
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('GET /api/curiosity/dispatches', () => {
  it('merges every bot newest first with bot name and avatar', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/curiosity/dispatches');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dispatches.map((d: Dispatch) => d.id)).toEqual(['d9', 'd3', 'd2', 'd1']);
    expect(body.dispatches[1].botName).toBe('Bot One');
    expect(body.dispatches[1].avatarUrl).toBe('/api/agents/b1/avatar?v=1');
    expect(body.dispatches[0].avatarUrl).toBeNull();
  });

  it('applies the limit after merging', async () => {
    const { app } = makeApp();
    const body = await (await app.request('/api/curiosity/dispatches?limit=2')).json();
    expect(body.dispatches.map((d: Dispatch) => d.id)).toEqual(['d9', 'd3']);
  });

  it('clamps a garbage limit to the default', async () => {
    const { app } = makeApp();
    const body = await (await app.request('/api/curiosity/dispatches?limit=abc')).json();
    expect(body.dispatches).toHaveLength(4);
  });

  it('scopes the inbox to the tenant', async () => {
    const { app } = makeApp({ tenantId: 't1' });
    const body = await (await app.request('/api/curiosity/dispatches')).json();
    expect(body.dispatches.map((d: Dispatch) => d.botId)).toEqual(['b1', 'b2', 'b1']);
  });
});

describe('GET /api/curiosity/:botId', () => {
  it('returns the snapshot with the bot name', async () => {
    const { app, calls } = makeApp();
    const res = await app.request('/api/curiosity/b1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.botId).toBe('b1');
    expect(body.botName).toBe('Bot One');
    expect(calls).toContain('snapshot:b1:20');
  });

  it('404s for unknown bots, bots outside the tenant and a null snapshot', async () => {
    expect((await makeApp().app.request('/api/curiosity/nope')).status).toBe(404);
    expect((await makeApp({ tenantId: 't1' }).app.request('/api/curiosity/b3')).status).toBe(404);
    const { app, svc } = makeApp();
    svc.snapshot = () => null;
    expect((await app.request('/api/curiosity/b1')).status).toBe(404);
  });
});

describe('POST /api/curiosity/:botId/dispatches/:id/signal', () => {
  it('records up / down / more', async () => {
    const { app, dispatches } = makeApp();
    for (const signal of ['up', 'down', 'more']) {
      const res = await post(app, '/api/curiosity/b1/dispatches/d1/signal', { signal });
      expect(res.status).toBe(200);
      expect((await res.json()).dispatch.signal).toBe(signal);
    }
    expect(dispatches.b1[0].signal).toBe('more');
  });

  it('400s on a bad signal or a bad body', async () => {
    const { app } = makeApp();
    expect(
      (await post(app, '/api/curiosity/b1/dispatches/d1/signal', { signal: 'meh' })).status
    ).toBe(400);
    expect((await post(app, '/api/curiosity/b1/dispatches/d1/signal', 'not json')).status).toBe(
      400
    );
  });

  it('404s on unknown dispatch, unknown bot and other tenants', async () => {
    const { app } = makeApp();
    expect(
      (await post(app, '/api/curiosity/b1/dispatches/zz/signal', { signal: 'up' })).status
    ).toBe(404);
    expect(
      (await post(app, '/api/curiosity/zz/dispatches/d1/signal', { signal: 'up' })).status
    ).toBe(404);
    const t = makeApp({ tenantId: 't2' }).app;
    expect((await post(t, '/api/curiosity/b1/dispatches/d1/signal', { signal: 'up' })).status).toBe(
      404
    );
  });
});

describe('POST /api/curiosity/:botId/frontier/:id/signal', () => {
  it('approves and drops', async () => {
    const { app, frontierById } = makeApp();
    const res = await post(app, '/api/curiosity/b1/frontier/f1/signal', { signal: 'up' });
    expect(res.status).toBe(200);
    expect((await res.json()).item.operatorSignal).toBe('up');
    await post(app, '/api/curiosity/b1/frontier/f1/signal', { signal: 'down' });
    expect(frontierById.b1[0].operatorSignal).toBe('down');
  });

  it("rejects 'more' (frontier takes up/down only)", async () => {
    const { app } = makeApp();
    expect(
      (await post(app, '/api/curiosity/b1/frontier/f1/signal', { signal: 'more' })).status
    ).toBe(400);
  });

  it('404s on unknown frontier item', async () => {
    const { app } = makeApp();
    expect(
      (await post(app, '/api/curiosity/b1/frontier/nope/signal', { signal: 'up' })).status
    ).toBe(404);
  });
});

describe('POST /api/curiosity/:botId/direction/signal', () => {
  it('records the verdict on the current direction', async () => {
    const { app, direction } = makeApp();
    const res = await post(app, '/api/curiosity/b1/direction/signal', { signal: 'down' });
    expect(res.status).toBe(200);
    expect((await res.json()).direction.operatorSignal).toBe('down');
    expect(direction.b1?.operatorSignal).toBe('down');
  });

  it('404s when the bot has no direction yet', async () => {
    const { app } = makeApp();
    expect((await post(app, '/api/curiosity/b2/direction/signal', { signal: 'up' })).status).toBe(
      404
    );
  });

  it('400s on a bad signal', async () => {
    const { app } = makeApp();
    expect((await post(app, '/api/curiosity/b1/direction/signal', {})).status).toBe(400);
  });
});

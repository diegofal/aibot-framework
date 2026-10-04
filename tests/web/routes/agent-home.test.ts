import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { KarmaEvent } from '../../../src/karma/types';
import { FLEET_PRESENCE_TTL_MS, mergeTimeline } from '../../../src/stats/agent-home-aggregator';
import { PresenceTracker } from '../../../src/stats/presence-tracker';
import { agentHomeRoutes } from '../../../src/web/routes/agent-home';
import { removeTempDir } from '../../helpers/temp-dir';
import { type StatsFixture, createStatsFixture } from '../../stats/fixture';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

const H = 3_600_000;

let fx: StatsFixture;
beforeEach(() => {
  fx = createStatsFixture();
});
afterEach(() => removeTempDir(fx.dir));

function karmaStub(events: KarmaEvent[] = []) {
  return {
    getScore: () => 62,
    getTrend: () => 'rising' as const,
    getRecentEvents: () => events,
  };
}

function makeApp(
  opts: {
    tenantId?: string;
    presence?: PresenceTracker;
    running?: boolean;
    executing?: boolean;
    now?: () => number;
    events?: KarmaEvent[];
  } = {}
) {
  const app = new Hono();
  if (opts.tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: opts.tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  app.route(
    '/api/agents',
    agentHomeRoutes({
      config: fx.config,
      botManager: {
        isRunning: () => opts.running ?? true,
        getAgentLoopState: () =>
          ({
            botSchedules: [
              {
                botId: 'b1',
                isExecutingLoop: opts.executing ?? false,
                nextRunAt: fx.now + 2 * H,
                lastRunAt: fx.now - H,
                skippedReason: null,
                lastErrorMessage: null,
              },
            ],
          }) as never,
      },
      logger: noopLogger,
      karmaService: karmaStub(opts.events),
      presence: opts.presence,
      pendingPermissions: (id) => (id === 'b1' ? 2 : 0),
      now: opts.now ?? (() => fx.now),
    })
  );
  return app;
}

describe('GET /api/agents/:id/home', () => {
  it('returns the frozen shape for a busy bot', async () => {
    const res = await makeApp().request('/api/agents/b1/home');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        'generatedAt',
        'goals',
        'identity',
        'karma',
        'needsYou',
        'presence',
        'timeline',
        'traits',
      ].sort()
    );
    expect(body.identity).toMatchObject({
      id: 'b1',
      name: 'Bot One',
      avatarSeed: 'b1',
      running: true,
    });
    expect(typeof body.presence.nowLine).toBe('string');
    expect(body.presence.nowLine.length).toBeGreaterThan(0);
    expect(['ok', 'warn', 'danger', 'info', 'muted']).toContain(body.presence.tone);
    expect(Array.isArray(body.goals.active)).toBe(true);
    expect(Array.isArray(body.goals.blocked)).toBe(true);
    expect(Array.isArray(body.goals.completedRecently)).toBe(true);
    expect(body.karma.score).toBe(62);
    expect(body.karma.trend).toBe('rising');
    expect(body.needsYou.permissions).toBe(2);
    expect(typeof body.needsYou.asks).toBe('number');
    expect(typeof body.needsYou.productionsPending).toBe('number');
  });

  it('merges llm and tool entries into a newest-first timeline', async () => {
    const body = await (await makeApp().request('/api/agents/b1/home')).json();
    const kinds = new Set(body.timeline.map((t: { kind: string }) => t.kind));
    expect(kinds.has('llm')).toBe(true);
    expect(kinds.has('tool')).toBe(true);
    for (let i = 1; i < body.timeline.length; i++) {
      expect(body.timeline[i - 1].ts >= body.timeline[i].ts).toBe(true);
    }
    const failed = body.timeline.find(
      (t: { ok: boolean; kind: string }) => t.kind === 'llm' && t.ok === false
    );
    expect(failed.detail).toContain('429');
  });

  it('builds a karma history that ends at the current score', async () => {
    const events: KarmaEvent[] = [
      {
        id: '1',
        botId: 'b1',
        timestamp: new Date(fx.now - 2 * H).toISOString(),
        delta: 3,
        reason: 'approved',
        source: 'production',
      },
      {
        id: '2',
        botId: 'b1',
        timestamp: new Date(fx.now - H).toISOString(),
        delta: -1,
        reason: 'tool error',
        source: 'tool',
      },
    ];
    const body = await (await makeApp({ events }).request('/api/agents/b1/home')).json();
    expect(body.karma.history.map((h: { score: number }) => h.score)).toEqual([63, 62]);
    expect(body.karma.recentEvents[0]).toMatchObject({
      delta: -1,
      reason: 'tool error',
      source: 'tool',
    });
    expect(
      body.timeline.some(
        (t: { kind: string; title: string }) => t.kind === 'karma' && t.title === 'Karma +3'
      )
    ).toBe(true);
  });

  it('never throws for a disabled bot with no data', async () => {
    const res = await makeApp().request('/api/agents/b2/home');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presence.posture).toBe('dormant');
    expect(body.presence.nowLine).toContain('disabled');
    expect(body.timeline).toEqual([]);
    expect(body.goals.active).toEqual([]);
  });

  it('404s for unknown bots and for bots outside the tenant', async () => {
    expect((await makeApp().request('/api/agents/nope/home')).status).toBe(404);
    expect((await makeApp({ tenantId: 't1' }).request('/api/agents/b3/home')).status).toBe(404);
    expect((await makeApp({ tenantId: 't2' }).request('/api/agents/b3/home')).status).toBe(200);
  });

  it('caches the home payload per bot', async () => {
    let t = fx.now;
    const app = makeApp({ now: () => t });
    const a = await (await app.request('/api/agents/b1/home')).json();
    t += 1000;
    const b = await (await app.request('/api/agents/b1/home')).json();
    expect(b.generatedAt).toBe(a.generatedAt);
  });
});

describe('GET /api/agents/:id/presence', () => {
  it('reflects the live tracker and is not cached', async () => {
    const tracker = new PresenceTracker();
    let t = fx.now;
    const app = makeApp({ presence: tracker, now: () => t });
    const idle = await (await app.request('/api/agents/b1/presence')).json();
    expect(idle.isExecuting).toBe(false);

    tracker.handle({ type: 'agent:phase', botId: 'b1', timestamp: t, phase: 'executor:start' });
    tracker.handle({
      type: 'tool:start',
      botId: 'b1',
      timestamp: t,
      data: { toolName: 'web_search' },
    });
    t += 1000;
    const busy = await (await app.request('/api/agents/b1/presence')).json();
    expect(busy).toMatchObject({
      isExecuting: true,
      phase: 'executor:start',
      currentTool: 'web_search',
      nowLine: "I'm working: running web_search.",
      tone: 'info',
    });
    expect(busy.generatedAt).not.toBe(idle.generatedAt);

    tracker.handle({ type: 'agent:result', botId: 'b1', timestamp: t });
    const after = await (await app.request('/api/agents/b1/presence')).json();
    expect(after.isExecuting).toBe(false);
  });

  it('uses the scheduler flag when no tracker is wired', async () => {
    const body = await (
      await makeApp({ executing: true }).request('/api/agents/b1/presence')
    ).json();
    expect(body.isExecuting).toBe(true);
    expect(body.nowLine).toContain('cycle');
  });

  it('says not running when the bot process is down', async () => {
    const body = await (
      await makeApp({ running: false }).request('/api/agents/b1/presence')
    ).json();
    expect(body.running).toBe(false);
    expect(body.nowLine).toBe("I'm not running right now.");
  });

  it('404s outside the tenant', async () => {
    expect((await makeApp({ tenantId: 't1' }).request('/api/agents/b3/presence')).status).toBe(404);
  });
});

describe('GET /api/agents/presence (fleet)', () => {
  it('returns one entry per accessible bot keyed by id, with the fleet card fields', async () => {
    const res = await makeApp().request('/api/agents/presence');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.generatedAt).toBe('string');
    expect(Object.keys(body.agents).sort()).toEqual(['b1', 'b2', 'b3']);
    const b1 = body.agents.b1;
    expect(Object.keys(b1).sort()).toEqual(
      [
        'id',
        'name',
        'posture',
        'nowLine',
        'tone',
        'enabled',
        'running',
        'isExecuting',
        'phase',
        'currentTool',
        'karma',
        'pendingAsks',
        'unreviewed',
        'lastRunAt',
        'nextRunAt',
        'lastOutputAt',
        'channel',
        'avatarUrl',
      ].sort()
    );
    expect(b1).toMatchObject({ id: 'b1', name: 'Bot One', karma: 62, running: true });
    expect(typeof b1.nowLine).toBe('string');
    expect(b1.channel).toMatchObject({ kind: expect.any(String), state: expect.any(String) });
    expect(body.agents.b2.posture).toBe('dormant');
    expect(body.agents.b2.enabled).toBe(false);
  });

  it('scopes the map to the tenant', async () => {
    const t1 = await (await makeApp({ tenantId: 't1' }).request('/api/agents/presence')).json();
    expect(Object.keys(t1.agents)).toEqual([]);
    const t2 = await (await makeApp({ tenantId: 't2' }).request('/api/agents/presence')).json();
    expect(Object.keys(t2.agents)).toEqual(['b3']);
  });

  it('reflects the live tracker and expires its short cache', async () => {
    const tracker = new PresenceTracker();
    let t = fx.now;
    const app = makeApp({ presence: tracker, now: () => t });
    const idle = await (await app.request('/api/agents/presence')).json();
    expect(idle.agents.b1.isExecuting).toBe(false);
    tracker.handle({ type: 'agent:phase', botId: 'b1', timestamp: t, phase: 'executor:start' });
    const cached = await (await app.request('/api/agents/presence')).json();
    expect(cached.generatedAt).toBe(idle.generatedAt);
    t += FLEET_PRESENCE_TTL_MS + 1;
    const fresh = await (await app.request('/api/agents/presence')).json();
    expect(fresh.agents.b1.isExecuting).toBe(true);
    expect(fresh.agents.b1.phase).toBe('executor:start');
  });

  it('is not shadowed by the per-bot routes', async () => {
    // A bot literally named "presence" would collide; the fleet route must win.
    expect((await makeApp().request('/api/agents/presence/home')).status).toBe(404);
    expect((await makeApp().request('/api/agents/b1/presence')).status).toBe(200);
  });
});

describe('mergeTimeline', () => {
  it('sorts newest first, drops items without a timestamp and caps the length', () => {
    const items = [
      { ts: '2026-01-01T00:00:00.000Z', kind: 'llm' as const, title: 'a', detail: null, ok: true },
      { ts: '', kind: 'llm' as const, title: 'bad', detail: null, ok: true },
      { ts: '2026-01-03T00:00:00.000Z', kind: 'tool' as const, title: 'c', detail: null, ok: true },
      { ts: '2026-01-02T00:00:00.000Z', kind: 'ask' as const, title: 'b', detail: null, ok: null },
    ];
    expect(mergeTimeline(items, 2).map((i) => i.title)).toEqual(['c', 'b']);
  });
});

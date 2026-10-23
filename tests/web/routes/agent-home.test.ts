import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { KarmaEvent } from '../../../src/karma/types';
import { FLEET_PRESENCE_TTL_MS, mergeTimeline } from '../../../src/stats/agent-home-aggregator';
import { PresenceTracker } from '../../../src/stats/presence-tracker';
import { parseGoals } from '../../../src/tools/goals';
import { agentHomeRoutes } from '../../../src/web/routes/agent-home';
import { type FakePool, createFakePool } from '../../helpers/fake-worker-pool';
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
    pool?: FakePool;
    runningCycle?: (botId: string) => unknown;
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
        ...(opts.runningCycle ? { getRunningCycle: opts.runningCycle as never } : {}),
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
      workerPool: opts.pool ? () => opts.pool : undefined,
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
        'traitChanges',
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

  it('carries the running cycle (watcher phase 4), null between cycles or without a reader', async () => {
    const withCycle = await (
      await makeApp({
        runningCycle: (id) =>
          id === 'b1'
            ? { cycleId: 'c-1', plan: 'Read filings', goalId: 'g-aaaaaaaa', goalTitle: 'Map Acme' }
            : undefined,
      }).request('/api/agents/b1/presence')
    ).json();
    expect(withCycle.cycle).toEqual({
      cycleId: 'c-1',
      plan: 'Read filings',
      goalId: 'g-aaaaaaaa',
      goalTitle: 'Map Acme',
    });
    const between = await (
      await makeApp({ runningCycle: () => undefined }).request('/api/agents/b1/presence')
    ).json();
    expect(between.cycle).toBeNull();
    const broken = await (
      await makeApp({
        runningCycle: () => {
          throw new Error('down');
        },
      }).request('/api/agents/b1/presence')
    ).json();
    expect(broken.cycle).toBeNull();
    expect((await (await makeApp().request('/api/agents/b1/presence')).json()).cycle).toBeNull();
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
        'workers',
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

describe('Why on Agent Home', () => {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const appendJsonl = (path: string, rows: unknown[]) => {
    mkdirSync(join(path, '..'), { recursive: true });
    appendFileSync(
      path,
      rows
        .map(
          (r) => `${JSON.stringify(r)}
`
        )
        .join('')
    );
  };
  const iso = (ms: number) => new Date(ms).toISOString();

  it('presence carries the posture rule as a Why', async () => {
    const body = await (await makeApp().request('/api/agents/b1/home')).json();
    expect(body.presence.postureWhy.what).toBe(`Posture: ${body.presence.posture}`);
    expect(typeof body.presence.postureWhy.rule).toBe('string');
    const live = await (await makeApp().request('/api/agents/b1/presence')).json();
    expect(live.postureWhy.rule).toBe(body.presence.postureWhy.rule);
  });

  it('timeline rows carry their cycle; cycles come from the cycle log with one Why each', async () => {
    const start = fx.now - 90 * 60_000;
    appendJsonl(join(fx.dir, 'agent-cycles', 'b1', `${day(start)}.jsonl`), [
      {
        cycleId: 'cyc-1',
        botId: 'b1',
        startedAt: iso(start),
        endedAt: iso(start + 40 * 60_000),
        status: 'completed',
        planSummary: 'Draft the digest',
        toolCalls: 1,
        tools: ['file_write'],
        goalId: 'g-1',
        goalTitle: 'Weekly digest',
      },
    ]);
    appendJsonl(join(fx.dir, 'tool-audit', 'b1', `${day(fx.now)}.jsonl`), [
      {
        timestamp: iso(start + 10 * 60_000),
        botId: 'b1',
        chatId: 0,
        toolName: 'web_search',
        args: {},
        success: true,
        result: 'ok',
        durationMs: 3,
        retryAttempts: 0,
        cycleId: 'cyc-1',
        goalId: 'g-1',
      },
    ]);
    const body = await (await makeApp().request('/api/agents/b1/home')).json();
    const tool = body.timeline.find((t: { title: string }) => t.title === 'web_search');
    expect(tool).toMatchObject({ cycleId: 'cyc-1', goalId: 'g-1' });
    const cycles = body.timeline.filter((t: { kind: string }) => t.kind === 'cycle');
    const logged = cycles.find((t: { cycleId?: string }) => t.cycleId === 'cyc-1');
    expect(logged.ts).toBe(iso(start + 40 * 60_000));
    expect(logged.detail).toBe('Draft the digest');
    expect(logged.why.goal).toEqual({ id: 'g-1', title: 'Weekly digest' });
    expect(logged.why.cycle).toMatchObject({ id: 'cyc-1', botId: 'b1' });
    // the scheduler's recentActions row (now - 1 h) is newer than the first logged
    // cycle, so it is the same history and is not shown twice
    expect(cycles.filter((t: { cycleId?: string }) => !t.cycleId)).toEqual([]);
  });

  it('asks keep the cycle and goal they were asked from', async () => {
    appendJsonl(join(fx.dir, 'conversations', 'b1', 'conversations.jsonl'), [
      {
        id: 'ask-cyc',
        botId: 'b1',
        type: 'inbox',
        title: 'Which city?',
        createdAt: iso(fx.now - 30 * 60_000),
        updatedAt: iso(fx.now - 30 * 60_000),
        inboxStatus: 'pending',
        cycleId: 'cyc-9',
        goalId: 'g-9',
      },
    ]);
    const body = await (await makeApp().request('/api/agents/b1/home')).json();
    const ask = body.timeline.find((t: { title: string }) => t.title === 'Asked: Which city?');
    expect(ask).toMatchObject({ cycleId: 'cyc-9', goalId: 'g-9' });
  });

  it('trait changes: newest first, each with a Why naming the trait, reason and cycle', async () => {
    const start = fx.now - 60 * 60_000;
    appendJsonl(join(fx.dir, 'agent-cycles', 'b1', `${day(start)}.jsonl`), [
      { cycleId: 'cyc-t', botId: 'b1', startedAt: iso(start), planSummary: 'Review errors' },
    ]);
    writeFileSync(
      join(fx.soulDir('b1'), 'TRAITS.json'),
      JSON.stringify({
        current: { curiosity: 0.5, caution: 0.53 },
        history: [
          { timestamp: start - 1000, source: 'adaptive', traits: { curiosity: 0.5, caution: 0.5 } },
          {
            timestamp: start + 1000,
            source: 'strategist',
            traits: { curiosity: 0.5, caution: 0.53 },
            cycleId: 'cyc-t',
            reasons: { caution: 'Repeated web_fetch errors.' },
            changes: { caution: { from: 0.5, to: 0.53, requested: 0.03 } },
          },
        ],
      })
    );
    const body = await (await makeApp().request('/api/agents/b1/home')).json();
    expect(body.traitChanges).toHaveLength(1);
    expect(body.traitChanges[0]).toMatchObject({ source: 'strategist', cycleId: 'cyc-t' });
    expect(body.traitChanges[0].why).toMatchObject({
      what: 'Trait adjusted: caution +0.03',
      reason: { text: 'Repeated web_fetch errors.', source: 'Strategist' },
      cycle: { id: 'cyc-t', plan: 'Review errors' },
    });
  });

  it('without a cycle log the scheduler cycles still show, without a cycle id', async () => {
    const body = await (await makeApp().request('/api/agents/b1/home')).json();
    const cycles = body.timeline.filter((t: { kind: string }) => t.kind === 'cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].cycleId).toBeUndefined();
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

describe('POST /api/agents/:id/goals', () => {
  const post = (app: Hono, id: string, body: unknown) =>
    app.request(`/api/agents/${id}/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const goalsOf = (id: string) =>
    parseGoals(readFileSync(join(fx.soulDir(id), 'GOALS.md'), 'utf-8'));

  it('appends an operator goal to the Active section and keeps the others', async () => {
    const res = await post(makeApp(), 'b1', {
      title: '  Find three remote FDE roles  ',
      notes: 'EU timezone',
      priority: 'high',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { goal: { text: string; source: string } };
    expect(body.goal.text).toBe('Find three remote FDE roles');
    const { active, completed } = goalsOf('b1');
    expect(active.map((g) => g.text)).toEqual([
      '**Weekly digest**',
      'Research topic',
      'Find three remote FDE roles',
    ]);
    const added = active[2];
    expect(added.source).toBe('operator');
    expect(added.priority).toBe('high');
    expect(added.notes).toBe('EU timezone');
    expect(added.status).toBe('pending');
    expect(added.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(completed.map((g) => g.text)).toEqual(['Setup']);
  });

  it('defaults priority to medium and rejects unknown priorities', async () => {
    expect((await post(makeApp(), 'b1', { title: 'A' })).status).toBe(201);
    expect(goalsOf('b1').active.at(-1)?.priority).toBe('medium');
    expect((await post(makeApp(), 'b1', { title: 'B', priority: 'urgent!!' })).status).toBe(400);
  });

  it('rejects empty, multi-line and oversized input', async () => {
    const app = makeApp();
    expect((await post(app, 'b1', { title: '   ' })).status).toBe(400);
    expect((await post(app, 'b1', {})).status).toBe(400);
    expect((await post(app, 'b1', { title: 'a\nb' })).status).toBe(400);
    expect((await post(app, 'b1', { title: 'x'.repeat(201) })).status).toBe(400);
    expect((await post(app, 'b1', { title: 'ok', notes: 'n'.repeat(601) })).status).toBe(400);
    expect(goalsOf('b1').active).toHaveLength(2);
  });

  it('flattens newlines in notes so GOALS.md stays parseable', async () => {
    await post(makeApp(), 'b1', { title: 'Notes goal', notes: 'line one\nline two' });
    expect(goalsOf('b1').active.at(-1)?.notes).toBe('line one line two');
  });

  it('404s for unknown bots and bots outside the tenant', async () => {
    expect((await post(makeApp(), 'nope', { title: 'x' })).status).toBe(404);
    expect((await post(makeApp({ tenantId: 't1' }), 'b3', { title: 'x' })).status).toBe(404);
  });

  it('shows the new goal on the next home read (cache dropped)', async () => {
    const app = makeApp();
    await app.request('/api/agents/b1/home');
    await post(app, 'b1', { title: 'Fresh goal' });
    const home = (await (await app.request('/api/agents/b1/home')).json()) as {
      goals: { active: Array<{ text: string; source: string | null }> };
    };
    const fresh = home.goals.active.find((g) => g.text === 'Fresh goal');
    expect(fresh?.source).toBe('operator');
  });
});

describe('PATCH /api/agents/:id/goals (move on the board)', () => {
  const patch = (app: Hono, id: string, body: unknown) =>
    app.request(`/api/agents/${id}/goals`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const goalsOf = (id: string) =>
    parseGoals(readFileSync(join(fx.soulDir(id), 'GOALS.md'), 'utf-8'));

  it('moves a goal to another column', async () => {
    const res = await patch(makeApp(), 'b1', { goal: 'Research topic', status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(goalsOf('b1').active.find((g) => g.text === 'Research topic')?.status).toBe(
      'in_progress'
    );
  });

  it('done completes the goal; a status other than done reopens it', async () => {
    const app = makeApp();
    expect((await patch(app, 'b1', { goal: 'Research topic', status: 'done' })).status).toBe(200);
    expect(goalsOf('b1').completed.map((g) => g.text)).toContain('Research topic');
    expect((await patch(app, 'b1', { goal: 'Setup', status: 'pending' })).status).toBe(200);
    expect(goalsOf('b1').active.map((g) => g.text)).toContain('Setup');
  });

  it('rejects bad input and unknown goals', async () => {
    const app = makeApp();
    expect((await patch(app, 'b1', { goal: 'Research topic', status: 'paused' })).status).toBe(400);
    expect((await patch(app, 'b1', { status: 'done' })).status).toBe(400);
    expect((await patch(app, 'b1', { goal: 'Nope', status: 'done' })).status).toBe(404);
    expect((await patch(app, 'nope', { goal: 'x', status: 'done' })).status).toBe(404);
  });

  it('home splits active goals into todo and in progress', async () => {
    const home = (await (await makeApp().request('/api/agents/b1/home')).json()) as {
      goals: { todo: Array<{ text: string }>; inProgress: Array<{ text: string }> };
    };
    expect(home.goals.todo.map((g) => g.text)).toEqual(['Research topic']);
    expect(home.goals.inProgress.map((g) => g.text)).toEqual(['**Weekly digest**']);
  });
});

describe('operator goal writes are logged as goal events', () => {
  const events = (id: string) => {
    const p = join(fx.soulDir(id), 'goal-events.jsonl');
    return existsSync(p)
      ? readFileSync(p, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  };
  const send = (app: Hono, method: string, body: unknown) =>
    app.request('/api/agents/b1/goals', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('POST appends an add event and PATCH a status event, both by the operator', async () => {
    const app = makeApp();
    await send(app, 'POST', { title: 'Logged goal' });
    await send(app, 'PATCH', { goal: 'Logged goal', status: 'in_progress' });
    const mine = events('b1').filter((e) => e.title === 'Logged goal');
    expect(mine.map((e) => e.op)).toEqual(['add', 'status']);
    expect(mine.every((e) => e.actor === 'operator')).toBe(true);
    expect(mine.every((e) => e.reason === 'You, from the dashboard')).toBe(true);
    expect(mine[1].to).toBe('in_progress');
    const goal = parseGoals(readFileSync(join(fx.soulDir('b1'), 'GOALS.md'), 'utf-8')).active.find(
      (g) => g.text === 'Logged goal'
    );
    expect(goal?.id).toMatch(/^g-[0-9a-f]{8}$/);
    expect(goal?.started).toBeTruthy();
  });
});

describe('PATCH /api/agents/:id/goals edits title and notes', () => {
  const patch = (app: Hono, body: unknown) =>
    app.request('/api/agents/b1/goals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const goals = () => parseGoals(readFileSync(join(fx.soulDir('b1'), 'GOALS.md'), 'utf-8'));
  const events = () => {
    const p = join(fx.soulDir('b1'), 'goal-events.jsonl');
    return existsSync(p)
      ? readFileSync(p, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  };

  it('renames a legacy goal (no id yet) as one title event and keeps its id afterwards', async () => {
    const app = makeApp();
    const res = await patch(app, { goal: 'Research topic', title: 'Research the topic deeply' });
    expect(res.status).toBe(200);
    const g = goals().active.find((x) => x.text === 'Research the topic deeply');
    expect(g?.id).toMatch(/^g-[0-9a-f]{8}$/);
    expect(goals().active.some((x) => x.text === 'Research topic')).toBe(false);
    const ops = events().map((e) => [e.op, e.actor, e.from, e.to]);
    expect(ops).toEqual([['title', 'operator', 'Research topic', 'Research the topic deeply']]);
    const res2 = await patch(app, { id: g?.id, notes: 'line one\nline two' });
    expect(res2.status).toBe(200);
    expect(goals().active.find((x) => x.id === g?.id)?.notes).toBe('line one line two');
    expect(events().at(-1)).toMatchObject({
      op: 'notes',
      actor: 'operator',
      reason: 'You, from the dashboard',
    });
  });

  it('rejects bad edits', async () => {
    const app = makeApp();
    expect((await patch(app, { goal: 'Research topic', title: '  ' })).status).toBe(400);
    expect((await patch(app, { goal: 'Research topic', title: 'a\nb' })).status).toBe(400);
    expect((await patch(app, { goal: 'Research topic', title: 'x'.repeat(201) })).status).toBe(400);
    expect((await patch(app, { goal: 'Research topic', notes: 'n'.repeat(601) })).status).toBe(400);
    expect((await patch(app, { goal: 'Research topic' })).status).toBe(400);
    expect((await patch(app, { id: 'g-nope', title: 'x' })).status).toBe(404);
  });
});

describe('goal tasks: op endpoints (task store)', () => {
  const call = (app: Hono, method: string, path: string, body?: unknown) =>
    app.request(`/api/agents/b1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const goals = () => parseGoals(readFileSync(join(fx.soulDir('b1'), 'GOALS.md'), 'utf-8'));
  const goalRef = encodeURIComponent('Research topic');
  const homeGoal = async (app: Hono) => {
    const home = await (await app.request('/api/agents/b1/home')).json();
    const all = [...home.goals.todo, ...home.goals.inProgress, ...home.goals.blocked];
    return { home, goal: all.find((x: { text: string }) => x.text === 'Research topic') };
  };

  it('PATCH /goals { tasks } is retired with a message naming the new endpoints', async () => {
    const res = await call(makeApp(), 'PATCH', '/goals', {
      goal: 'Research topic',
      tasks: [{ text: 'x', done: false }],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('/goals/:goalId/tasks');
    expect(body.error).toContain('/tasks/:taskId');
  });

  it('POST adds a task (by title for a goal without id, then by id); the home payload shows it with rev', async () => {
    const app = makeApp();
    const res = await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: '  Find 3 sources ' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rev).toBe(1);
    expect(body.task).toMatchObject({ text: 'Find 3 sources', lane: 'todo', by: 'operator' });
    const id = goals().active.find((g) => g.text === 'Research topic')?.id as string;
    expect(id).toMatch(/^g-/);
    const second = await call(app, 'POST', `/goals/${id}/tasks`, {
      text: 'Write summary',
      lane: 'in_progress',
    });
    expect(second.status).toBe(201);
    expect(goals().active.find((g) => g.id === id)?.status).toBe('in_progress');
    expect(readFileSync(join(fx.soulDir('b1'), 'GOALS.md'), 'utf-8')).not.toContain('- task:');
    const { home, goal } = await homeGoal(app);
    expect(home.goals.tasksRev).toBe(2);
    expect(goal.tasks).toMatchObject([
      { text: 'Find 3 sources', lane: 'todo', status: 'todo', done: false, by: 'operator' },
      { text: 'Write summary', lane: 'in_progress', status: 'in_progress', done: false },
    ]);
  });

  it('PATCH moves, renames and notes a task; DELETE removes it; every response has rev', async () => {
    const app = makeApp();
    const added = await (
      await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: 'Draft' })
    ).json();
    const tid = added.task.id;
    const moved = await call(app, 'PATCH', `/tasks/${tid}`, { lane: 'done', expectedRev: 1 });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ rev: 2, task: { lane: 'done', done: true } });
    const renamed = await (
      await call(app, 'PATCH', `/tasks/${tid}`, { text: 'Draft v2', note: 'sent to Ana' })
    ).json();
    expect(renamed).toMatchObject({ rev: 3, task: { text: 'Draft v2', note: 'sent to Ana' } });
    const del = await call(app, 'DELETE', `/tasks/${tid}`);
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ removed: tid, rev: 4 });
    const { goal } = await homeGoal(app);
    expect(goal.tasks).toEqual([]);
  });

  it('a stale expectedRev is 409 with the current rev', async () => {
    const app = makeApp();
    const added = await (await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: 'A' })).json();
    await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: 'Bravo charlie' });
    const res = await call(app, 'PATCH', `/tasks/${added.task.id}`, {
      lane: 'done',
      expectedRev: 1,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ rev: 2 });
  });

  it('reorder sets the order of a goal’s tasks', async () => {
    const app = makeApp();
    const a = (await (await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: 'Alpha' })).json())
      .task.id;
    const b = (await (await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: 'Bravo' })).json())
      .task.id;
    const res = await call(app, 'POST', `/goals/${goalRef}/tasks/reorder`, {
      ids: [b, a],
      expectedRev: 2,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).rev).toBe(3);
    const { goal } = await homeGoal(app);
    expect(goal.tasks.map((t: { id: string }) => t.id)).toEqual([b, a]);
    expect((await call(app, 'POST', `/goals/${goalRef}/tasks/reorder`, { ids: 'x' })).status).toBe(
      400
    );
  });

  it('an operator move of a claimed task releases the claim and reports it', async () => {
    const app = makeApp();
    const tid = (
      await (await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: 'Work' })).json()
    ).task.id;
    const { TaskStore } = await import('../../../src/goals/task-store');
    new TaskStore(fx.soulDir('b1')).apply(
      [{ op: 'claim', id: tid, runId: 'r-1', ttlMs: 3_600_000 }],
      { actor: 'system' }
    );
    const { goal } = await homeGoal(app);
    expect(goal.tasks[0].claim).toEqual({ runId: 'r-1' });
    const res = await call(app, 'PATCH', `/tasks/${tid}`, { lane: 'todo' });
    expect(await res.json()).toMatchObject({ releasedClaim: { runId: 'r-1' } });
  });

  it('validation: 400 for bad input, 404 for unknown goal or task, 404 across tenants', async () => {
    const app = makeApp();
    expect((await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: '' })).status).toBe(400);
    expect((await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: 'a\nb' })).status).toBe(400);
    expect(
      (await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: 'x'.repeat(201) })).status
    ).toBe(400);
    expect(
      (await call(app, 'POST', `/goals/${goalRef}/tasks`, { text: 'ok', lane: 'later' })).status
    ).toBe(400);
    expect((await call(app, 'POST', '/goals/g-nope/tasks', { text: 'ok' })).status).toBe(404);
    expect((await call(app, 'PATCH', '/tasks/t-000000', { lane: 'done' })).status).toBe(404);
    expect((await call(app, 'PATCH', '/tasks/t-000000', {})).status).toBe(400);
    expect((await call(app, 'DELETE', '/tasks/t-000000')).status).toBe(404);
    const other = makeApp({ tenantId: 't1' });
    const res = await other.request('/api/agents/b3/goals/x/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('workers on Agent Home (C19/C20)', () => {
  const workerEvent = (type: 'worker:started' | 'worker:waiting', runId: string, extra = {}) => ({
    type,
    botId: 'b1',
    timestamp: fx.now - 60_000,
    data: {
      runId,
      taskId: 't-1',
      goalId: 'g-1',
      status: type === 'worker:waiting' ? 'waiting' : 'running',
      step: 1,
      budget: { steps: 8, toolCalls: 40, wallMs: 3_600_000 },
      used: { steps: 1, toolCalls: 2, wallMs: 1000 },
      ...extra,
    },
  });

  it('presence and fleet presence carry the live workers; none without a tracker', async () => {
    const tracker = new PresenceTracker();
    tracker.handle(workerEvent('worker:started', 'r-1') as never);
    tracker.handle({
      type: 'tool:start',
      botId: 'b1',
      timestamp: fx.now,
      data: { toolName: 'web_fetch', runId: 'r-1' },
    });
    const app = makeApp({ presence: tracker });
    const p = await (await app.request('/api/agents/b1/presence')).json();
    expect(p.isExecuting).toBe(false);
    expect(p.currentTool).toBeNull();
    expect(p.workers).toMatchObject([{ runId: 'r-1', step: 1, tool: 'web_fetch' }]);
    const fleet = await (await app.request('/api/agents/presence')).json();
    expect(fleet.agents.b1.workers).toHaveLength(1);
    expect(fleet.agents.b2.workers).toEqual([]);
    const none = await (await makeApp().request('/api/agents/b1/presence')).json();
    expect(none.workers).toEqual([]);
  });

  const call = (app: Hono, method: string, path: string, body?: unknown) =>
    app.request(`/api/agents/b1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const claimedTask = async (app: Hono) => {
    const tid = (
      await (
        await call(app, 'POST', `/goals/${encodeURIComponent('Research topic')}/tasks`, {
          text: 'Work',
        })
      ).json()
    ).task.id;
    const { TaskStore } = await import('../../../src/goals/task-store');
    new TaskStore(fx.soulDir('b1')).apply(
      [{ op: 'claim', id: tid, runId: 'r-1', ttlMs: 3_600_000 }],
      { actor: 'system' }
    );
    return tid as string;
  };

  it('an operator move of a claimed task stops its worker (task-moved)', async () => {
    const pool = createFakePool();
    const app = makeApp({ pool });
    const tid = await claimedTask(app);
    const res = await call(app, 'PATCH', `/tasks/${tid}`, { lane: 'todo' });
    expect(res.status).toBe(200);
    expect(pool.stops).toEqual([{ runId: 'r-1', reason: 'task-moved' }]);
  });

  it('an operator remove of a claimed task stops its worker', async () => {
    const pool = createFakePool();
    const app = makeApp({ pool });
    const tid = await claimedTask(app);
    expect((await call(app, 'DELETE', `/tasks/${tid}`)).status).toBe(200);
    expect(pool.stops).toEqual([{ runId: 'r-1', reason: 'task-moved' }]);
  });

  it('a move without a claim, or without a pool, stops nothing and still answers', async () => {
    const pool = createFakePool();
    const app = makeApp({ pool });
    const tid = (
      await (
        await call(app, 'POST', `/goals/${encodeURIComponent('Research topic')}/tasks`, {
          text: 'Plain',
        })
      ).json()
    ).task.id;
    await call(app, 'PATCH', `/tasks/${tid}`, { lane: 'done' });
    expect(pool.stops).toEqual([]);
    const bare = makeApp();
    const t2 = await claimedTask(bare);
    const res = await call(bare, 'PATCH', `/tasks/${t2}`, { lane: 'todo' });
    expect(await res.json()).toMatchObject({ releasedClaim: { runId: 'r-1' } });
  });

  it('a pool whose stop throws never fails the task write', async () => {
    const pool = createFakePool();
    pool.stop = () => {
      throw new Error('boom');
    };
    const app = makeApp({ pool });
    const tid = await claimedTask(app);
    expect((await call(app, 'PATCH', `/tasks/${tid}`, { lane: 'todo' })).status).toBe(200);
  });
});

describe('goal delete (fleet board)', () => {
  const send = (app: Hono, method: string, body: unknown) =>
    app.request('/api/agents/b1/goals', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const goals = () => parseGoals(readFileSync(join(fx.soulDir('b1'), 'GOALS.md'), 'utf-8'));

  it('DELETE removes a goal by id or title and logs a remove event; unknown is 404', async () => {
    const app = makeApp();
    await send(app, 'POST', { title: 'Throwaway' });
    const id = goals().active.find((x) => x.text === 'Throwaway')?.id;
    const res = await send(app, 'DELETE', { id });
    expect(res.status).toBe(200);
    expect(goals().active.some((x) => x.text === 'Throwaway')).toBe(false);
    const log = readFileSync(join(fx.soulDir('b1'), 'goal-events.jsonl'), 'utf-8');
    expect(log).toContain('"op":"remove"');
    expect((await send(app, 'DELETE', { id: 'g-nope' })).status).toBe(404);
    expect((await send(app, 'DELETE', {})).status).toBe(400);
  });
});

describe('goal headline and brief edits (fleet board drawer)', () => {
  const patch = (app: Hono, body: unknown) =>
    app.request('/api/agents/b1/goals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const goals = () => parseGoals(readFileSync(join(fx.soulDir('b1'), 'GOALS.md'), 'utf-8'));

  it('headline sets the short title; brief rewrites the full text up to 1000 chars', async () => {
    const app = makeApp();
    expect((await patch(app, { goal: 'Research topic', headline: '  Research  ' })).status).toBe(
      200
    );
    expect(goals().active.find((g) => g.text === 'Research topic')?.headline).toBe('Research');
    const long = `Research the topic. ${'detail '.repeat(100)}`.trim();
    expect((await patch(app, { goal: 'Research topic', brief: long })).status).toBe(200);
    const g = goals().active.find((x) => x.headline === 'Research');
    expect(g?.text).toBe(long);
    const home = await (await app.request('/api/agents/b1/home')).json();
    const all = [...home.goals.todo, ...home.goals.inProgress, ...home.goals.blocked];
    expect(all.find((x: { headline: string | null }) => x.headline === 'Research')).toBeTruthy();
  });

  it('accepts a headline up to 200 characters', async () => {
    const app = makeApp();
    expect((await patch(app, { goal: 'Research topic', headline: 'x'.repeat(200) })).status).toBe(
      200
    );
  });

  it('rejects bad headline and brief values', async () => {
    const app = makeApp();
    expect((await patch(app, { goal: 'Research topic', headline: 'x'.repeat(201) })).status).toBe(
      400
    );
    expect((await patch(app, { goal: 'Research topic', headline: 'a\nb' })).status).toBe(400);
    expect((await patch(app, { goal: 'Research topic', brief: '' })).status).toBe(400);
    expect((await patch(app, { goal: 'Research topic', brief: 'x'.repeat(1001) })).status).toBe(
      400
    );
  });
});

describe('goal activity and spawned goals (fleet board)', () => {
  const DAY = 24 * H;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  function setup() {
    writeFileSync(
      join(fx.soulDir('b1'), 'GOALS.md'),
      [
        '## Active Goals',
        '- [ ] Research what people say about LLMs',
        '  - status: in_progress',
        '  - priority: medium',
        '  - source: operator',
        '  - id: g-7cb6a370',
        '- [ ] Monthly lab',
        '  - status: in_progress',
        '  - priority: medium',
        '  - id: g-0b7cdc2f',
        '',
        '## Completed',
        '- [x] Publish the first daily practitioner digest',
        '  - completed: 2026-10-11',
        '  - notes: Top priority this cycle.',
        '  - source: reflection:2026-10-11',
        '  - parent: g-7cb6a370',
        '  - id: g-1001d015',
        '',
      ].join('\n')
    );
    const rows = [
      { at: fx.now - 8 * H, goalId: 'g-7cb6a370', status: 'completed' },
      { at: fx.now - 30 * H, goalId: 'g-7cb6a370', status: 'completed' },
      { at: fx.now - 2 * H, goalId: 'g-7cb6a370', status: 'idle' },
      { at: fx.now - 2 * DAY - H, goalId: 'g-0b7cdc2f', status: 'completed' },
    ];
    for (const r of rows) {
      const dir = join(fx.dir, 'agent-cycles', 'b1');
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, `${day(r.at)}.jsonl`),
        `${JSON.stringify({ cycleId: `c${r.at}`, botId: 'b1', startedAt: new Date(r.at).toISOString(), endedAt: new Date(r.at + 60_000).toISOString(), status: r.status, goalId: r.goalId })}\n`
      );
    }
  }

  it('carries per-goal activity and the loop interval', async () => {
    setup();
    const body = await (await makeApp().request('/api/agents/b1/home')).json();
    const a = body.goals.activity['g-7cb6a370'];
    expect(a.lastCycleAt).toBe(new Date(fx.now - 8 * H).toISOString());
    expect(a.cycles7d).toBe(2);
    expect(a.daily).toHaveLength(7);
    expect(body.goals.activity['g-0b7cdc2f'].cycles7d).toBe(1);
    expect(typeof body.goals.loopIntervalMs).toBe('number');
    expect(body.goals.loopIntervalMs).toBeGreaterThan(0);
  });

  it('carries the turn interval: the loop shared by the goals, stretched by cycles that served none', async () => {
    setup();
    const body = await (await makeApp().request('/api/agents/b1/home')).json();
    // two goals that can move; 3 of the 4 cycles in the week served a goal
    expect(body.goals.turnIntervalMs).toBe(Math.round((body.goals.loopIntervalMs * 2) / 0.75));
  });

  it('lists the goals spawned from each goal, with parent on the child', async () => {
    setup();
    const body = await (await makeApp().request('/api/agents/b1/home')).json();
    const kids = body.goals.spawned['g-7cb6a370'];
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({
      id: 'g-1001d015',
      text: 'Publish the first daily practitioner digest',
      section: 'completed',
      completed: '2026-10-11',
      notes: 'Top priority this cycle.',
      source: 'reflection:2026-10-11',
      parent: 'g-7cb6a370',
    });
    expect(body.goals.spawned['g-0b7cdc2f']).toBeUndefined();
    const parent = body.goals.inProgress.find((g: { id: string }) => g.id === 'g-7cb6a370');
    expect(parent.parent).toBeNull();
  });

  it('no cycle log: empty activity, never a 500', async () => {
    const res = await makeApp().request('/api/agents/b1/home');
    expect(res.status).toBe(200);
    expect((await res.json()).goals.activity).toEqual({});
  });
});

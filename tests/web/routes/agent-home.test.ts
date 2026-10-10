import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { KarmaEvent } from '../../../src/karma/types';
import { FLEET_PRESENCE_TTL_MS, mergeTimeline } from '../../../src/stats/agent-home-aggregator';
import { PresenceTracker } from '../../../src/stats/presence-tracker';
import { parseGoals } from '../../../src/tools/goals';
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
    expect(events().at(-1)).toMatchObject({ op: 'notes', actor: 'operator' });
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

describe('goal subtasks and delete (fleet board)', () => {
  const send = (app: Hono, method: string, body: unknown) =>
    app.request('/api/agents/b1/goals', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const goals = () => parseGoals(readFileSync(join(fx.soulDir('b1'), 'GOALS.md'), 'utf-8'));

  it('PATCH { tasks } replaces the subtask list and the home payload shows it', async () => {
    const app = makeApp();
    const res = await send(app, 'PATCH', {
      goal: 'Research topic',
      tasks: [
        { text: '  Find 3 sources ', done: true },
        { text: 'Write summary', done: false },
      ],
    });
    expect(res.status).toBe(200);
    const g = goals().active.find((x) => x.text === 'Research topic');
    expect(g?.tasks).toEqual([
      { text: 'Find 3 sources', done: true },
      { text: 'Write summary', done: false },
    ]);
    const home = await (await app.request('/api/agents/b1/home')).json();
    const all = [...home.goals.todo, ...home.goals.inProgress, ...home.goals.blocked];
    expect(all.find((x: { text: string }) => x.text === 'Research topic').tasks).toEqual(g?.tasks);
  });

  it('rejects bad task lists', async () => {
    const app = makeApp();
    const bad = [
      'nope',
      [{ text: '', done: false }],
      [{ text: 'a\nb', done: false }],
      [{ text: 'x'.repeat(201), done: false }],
      [{ text: 'ok', done: 'yes' }],
      Array.from({ length: 31 }, (_, i) => ({ text: `t${i}`, done: false })),
    ];
    for (const tasks of bad) {
      expect((await send(app, 'PATCH', { goal: 'Research topic', tasks })).status).toBe(400);
    }
  });

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

  it('rejects bad headline and brief values', async () => {
    const app = makeApp();
    expect((await patch(app, { goal: 'Research topic', headline: 'x'.repeat(101) })).status).toBe(
      400
    );
    expect((await patch(app, { goal: 'Research topic', headline: 'a\nb' })).status).toBe(400);
    expect((await patch(app, { goal: 'Research topic', brief: '' })).status).toBe(400);
    expect((await patch(app, { goal: 'Research topic', brief: 'x'.repeat(1001) })).status).toBe(
      400
    );
  });
});

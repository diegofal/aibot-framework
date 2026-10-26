import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import { WATCHER_DEFAULTS } from '../../../src/watcher/types';
import { Watcher, type WatcherDeps } from '../../../src/watcher/watcher';
import { watcherRoutes } from '../../../src/web/routes/watcher';
import { WhySchema } from '../../../src/why/types';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

let root: string;
let t: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watcher-routes-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(enabled = true, extra: Partial<WatcherDeps> = {}) {
  const soulDir = join(root, 'souls', 'b1');
  mkdirSync(soulDir, { recursive: true });
  writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Jarvis\n');
  writeFileSync(
    join(soulDir, 'GOALS.md'),
    '# Goals\n\n## Active\n\n- [ ] Ship it\n  - id: g-aaaaaaaa\n  - status: in_progress\n  - priority: high\n\n## Completed\n'
  );
  const config = {
    bots: [{ id: 'b1', name: 'b1', soulDir, enabled: true, tenantId: 't1' }],
    paths: { data: join(root, 'data') },
    soul: {},
    operator: {},
    watcher: { ...WATCHER_DEFAULTS, enabled },
  } as unknown as Config;
  const watcher = enabled
    ? new Watcher({
        config: () => config,
        logger: noopLogger,
        activityStream: new EventEmitter(),
        hooks: new EventEmitter(),
        botManager: {
          getChannelState: () => undefined,
          getUserDirectory: () => ({ list: () => [], findByChannel: () => undefined }) as never,
        },
        now: () => t,
        ...extra,
      })
    : undefined;
  return { config, watcher };
}

function app(config: Config, watcher: Watcher | undefined, tenantId?: string) {
  const a = new Hono();
  if (tenantId) {
    a.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  a.route('/api/watcher', watcherRoutes({ config, logger: noopLogger, watcher: () => watcher }));
  return a;
}

const post = (a: Hono, path: string) => a.request(path, { method: 'POST' });

describe('watcher routes', () => {
  it('answers { enabled: false } when the watcher is off', async () => {
    const { config } = setup(false);
    const res = await app(config, undefined).request('/api/watcher');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it('404s the other routes when the watcher is off', async () => {
    const { config } = setup(false);
    const a = app(config, undefined);
    for (const path of [
      '/api/watcher/graph',
      '/api/watcher/log',
      '/api/watcher/birth',
      '/api/watcher/neurons/n-1',
    ])
      expect((await a.request(path)).status).toBe(404);
    expect((await post(a, '/api/watcher/start')).status).toBe(404);
  });

  it('every 404 while the watcher is off says enabled: false, so the page can show the off state', async () => {
    const { config } = setup(false);
    const a = app(config, undefined);
    for (const path of [
      '/api/watcher/graph',
      '/api/watcher/log',
      '/api/watcher/birth',
      '/api/watcher/neurons/n-1',
    ])
      expect(await (await a.request(path)).json()).toEqual({
        enabled: false,
        error: 'The watcher is off',
      });
    for (const path of ['/api/watcher/start', '/api/watcher/stop'])
      expect(await (await post(a, path)).json()).toEqual({
        enabled: false,
        error: 'The watcher is off',
      });
  });

  it('a tenant 404 never reveals whether the watcher is on', async () => {
    const { config, watcher } = setup();
    const body = await (await app(config, watcher, 't1').request('/api/watcher/graph')).json();
    expect(body).toEqual({ error: 'Not found' });
  });

  it('a tenant gets 404 on every route', async () => {
    const { config, watcher } = setup();
    const a = app(config, watcher, 't1');
    for (const path of [
      '/api/watcher',
      '/api/watcher/graph',
      '/api/watcher/log',
      '/api/watcher/birth',
    ])
      expect((await a.request(path)).status).toBe(404);
    expect((await post(a, '/api/watcher/start')).status).toBe(404);
  });

  it('admin in multi-tenant passes', async () => {
    const { config, watcher } = setup();
    const res = await app(config, watcher, '__admin__').request('/api/watcher');
    expect(res.status).toBe(200);
  });

  it('GET returns the state with enabled: true; start and stop return it too', async () => {
    const { config, watcher } = setup();
    const a = app(config, watcher);
    const idle = await (await a.request('/api/watcher')).json();
    expect(idle).toMatchObject({
      enabled: true,
      running: false,
      phase: 'sleep',
      linkStatus: 'pending',
    });
    expect(idle.counts.entity).toBe(0);
    const started = await (await post(a, '/api/watcher/start')).json();
    expect(started).toMatchObject({ enabled: true, running: true });
    await watcher?.idle();
    const stopped = await (await post(a, '/api/watcher/stop')).json();
    expect(stopped).toMatchObject({ enabled: true, running: false, phase: 'sleep' });
    expect(stopped.bornAt).toBe('2026-10-23T10:00:00.000Z');
  });

  it('graph excludes embeddings and carries linkStatus and rev', async () => {
    const { config, watcher } = setup();
    await watcher?.start();
    await watcher?.idle();
    const n = watcher?.graph.list()[0];
    if (n) watcher?.graph.setEmbedding(n.id, [0.123456, 0.654321]);
    const body = await (await app(config, watcher).request('/api/watcher/graph')).json();
    expect(body.neurons.length).toBe(2);
    expect(body.edges.length).toBe(1);
    expect(body.linkStatus).toBe('no-embeddings');
    expect(typeof body.rev).toBe('number');
    const raw = JSON.stringify(body);
    expect(body.neurons.some((x: object) => 'embedding' in x)).toBe(false);
    expect(raw).not.toContain('0.123456');
    await watcher?.stop();
  });

  it('graph is capped at maxNeurons, most recently active first', async () => {
    const { config, watcher } = setup();
    (config.watcher as { graph: { maxNeurons: number } }).graph = {
      ...WATCHER_DEFAULTS.graph,
      maxNeurons: 1,
    };
    await watcher?.start();
    await watcher?.idle();
    const body = await (await app(config, watcher).request('/api/watcher/graph')).json();
    expect(body.neurons).toHaveLength(1);
    expect(body.edges).toHaveLength(0);
    await watcher?.stop();
  });

  it('log pages newest first, by date and before', async () => {
    const { config, watcher } = setup();
    await watcher?.start();
    await watcher?.idle();
    const a = app(config, watcher);
    const all = (await (await a.request('/api/watcher/log')).json()).rows;
    expect(all.length).toBeGreaterThan(3);
    expect(all[0].seq).toBeGreaterThan(all[1].seq);
    const two = (await (await a.request('/api/watcher/log?limit=2')).json()).rows;
    expect(two.map((r: { seq: number }) => r.seq)).toEqual([all[0].seq, all[1].seq]);
    const older = (await (await a.request(`/api/watcher/log?limit=2&before=${two[1].seq}`)).json())
      .rows;
    expect(older[0].seq).toBe(two[1].seq - 1);
    const day = (await (await a.request('/api/watcher/log?date=2026-10-23')).json()).rows;
    expect(day.length).toBe(all.length);
    expect((await (await a.request('/api/watcher/log?date=2026-10-01')).json()).rows).toEqual([]);
    expect((await a.request('/api/watcher/log?date=nope')).status).toBe(400);
    await watcher?.stop();
  });

  it('neurons/:id returns the neuron, its edges and a valid why', async () => {
    const { config, watcher } = setup();
    await watcher?.start();
    await watcher?.idle();
    const goal = watcher?.graph.list().find((n) => n.kind === 'goal');
    const a = app(config, watcher);
    const body = await (await a.request(`/api/watcher/neurons/${goal?.id}`)).json();
    expect(body.neuron.id).toBe(goal?.id);
    expect(body.edges).toHaveLength(1);
    expect(WhySchema.safeParse(body.why).success).toBe(true);
    expect((await a.request('/api/watcher/neurons/n-nope')).status).toBe(404);
    await watcher?.stop();
  });

  it('birth returns birth.json, or {} before birth', async () => {
    const { config, watcher } = setup();
    const a = app(config, watcher);
    expect(await (await a.request('/api/watcher/birth')).json()).toEqual({});
    await watcher?.start();
    await watcher?.idle();
    const body = await (await a.request('/api/watcher/birth')).json();
    expect(body.finishedAt).toBe('2026-10-23T10:00:00.000Z');
    await watcher?.stop();
  });
});

describe('watcher routes (phase 3)', () => {
  const postJson = (a: Hono, path: string, body: unknown) =>
    a.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET /metrics parses the window and answers the metric table', async () => {
    const { config, watcher } = setup();
    const a = app(config, watcher);
    const week = await (await a.request('/api/watcher/metrics')).json();
    expect(week.window).toBe('7d');
    expect(week.metrics).toHaveLength(8);
    expect(week.guards).toHaveLength(5); // O10 added graphSize
    expect(JSON.stringify(week)).not.toContain('NaN');
    const month = await (await a.request('/api/watcher/metrics?window=30d')).json();
    expect(month.window).toBe('30d');
    expect((await a.request('/api/watcher/metrics?window=24h')).status).toBe(400);
  });

  it('GET /metrics is 404 when off and for tenants', async () => {
    const off = setup(false);
    expect((await app(off.config, undefined).request('/api/watcher/metrics')).status).toBe(404);
    const { config, watcher } = setup();
    expect((await app(config, watcher, 't1').request('/api/watcher/metrics')).status).toBe(404);
  });

  it('GET /broadcasts lists them newest first, with a why for each', async () => {
    const { config, watcher } = setup();
    const w = watcher as Watcher;
    await w.broadcaster.send({ botId: 'b1', kind: 'wake', text: '', insightId: 'n-1' });
    t += 1000;
    await w.broadcaster.send({
      botId: 'b1',
      kind: 'directive',
      text: 'Check it',
      insightId: 'n-2',
    });
    const a = app(config, w);
    const body = await (await a.request('/api/watcher/broadcasts')).json();
    expect(body.broadcasts.map((b: { insightId: string }) => b.insightId)).toEqual(['n-2', 'n-1']);
    for (const b of body.broadcasts) expect(WhySchema.safeParse(b.why).success).toBe(true);
    const one = await (await a.request('/api/watcher/broadcasts?limit=1')).json();
    expect(one.broadcasts).toHaveLength(1);
  });

  it('POST /neurons/:id/signal stores 👍/👎 on an insight', async () => {
    const { config, watcher } = setup();
    const w = watcher as Watcher;
    w.graph.load();
    const insight = w.graph.addNeuron({
      kind: 'insight',
      text: 'An insight',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    const a = app(config, w);
    const res = await postJson(a, `/api/watcher/neurons/${insight.id}/signal`, { signal: 'up' });
    expect(res.status).toBe(200);
    expect((await res.json()).neuron.meta.signal).toBe('up');
    expect(w.graph.get(insight.id)?.meta?.signal).toBe('up');
  });

  it('POST /neurons/:id/signal also takes a broadcast id', async () => {
    const { config, watcher } = setup();
    const w = watcher as Watcher;
    const sent = await w.broadcaster.send({
      botId: 'b1',
      kind: 'wake',
      text: '',
      insightId: 'n-1',
    });
    const id = sent.broadcast?.id as string;
    const res = await postJson(app(config, w), `/api/watcher/neurons/${id}/signal`, {
      signal: 'down',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).broadcast.signal).toBe('down');
  });

  it('POST /neurons/:id/signal refuses bad input and unknown or unsignalable ids', async () => {
    const { config, watcher } = setup();
    const w = watcher as Watcher;
    w.graph.load();
    const fact = w.graph.addNeuron({
      kind: 'fact',
      text: 'A fact',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    const a = app(config, w);
    expect(
      (await postJson(a, `/api/watcher/neurons/${fact.id}/signal`, { signal: 'meh' })).status
    ).toBe(400);
    expect(
      (await postJson(a, `/api/watcher/neurons/${fact.id}/signal`, { signal: 'up' })).status
    ).toBe(404);
    expect((await postJson(a, '/api/watcher/neurons/n-nope/signal', { signal: 'up' })).status).toBe(
      404
    );
    expect((await postJson(a, '/api/watcher/neurons/b-nope/signal', { signal: 'up' })).status).toBe(
      404
    );
  });
});

describe('watcher routes (phase 4)', () => {
  const noticeLlm = (text: string) => ({
    notice: {
      client: {
        backend: 'claude-cli',
        generate: async () => ({ text: '' }),
        chat: async () => ({ text, usage: { model: 'claude-haiku-5-5', totalTokens: 90 } }),
      } as never,
      model: 'claude-haiku-5-5',
      backend: 'claude-cli' as const,
    },
  });
  const reply = JSON.stringify({ phase: 'sense', tool: null, goal: null, cause: null });

  it('POST /introspect asks the watcher, scores and appends the row', async () => {
    const { config, watcher } = setup(true, { llm: noticeLlm(reply) });
    await watcher?.start();
    await watcher?.idle();
    const a = app(config, watcher);
    const res = await post(a, '/api/watcher/introspect');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('scored');
    expect(body.record).toMatchObject({ subject: 'watcher', trigger: 'manual', parsed: true });
    const self = await (await a.request('/api/watcher/self')).json();
    expect(self.introspection).toHaveLength(1);
    await watcher?.stop();
  });

  it('POST /introspect is 409 when the watcher cannot be asked', async () => {
    const { config, watcher } = setup();
    const res = await post(app(config, watcher), '/api/watcher/introspect');
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe('unavailable');
  });

  it('POST /introspect is 429 when the budget refuses', async () => {
    const { config, watcher } = setup(true, { llm: noticeLlm(reply) });
    (config.watcher as { notice: { maxPerDay: number } }).notice.maxPerDay = 0;
    await watcher?.start();
    await watcher?.idle();
    const res = await post(app(config, watcher), '/api/watcher/introspect');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ status: 'refused', reason: 'cap' });
    await watcher?.stop();
  });

  it('GET /self answers interoception, attention and the introspection history', async () => {
    const { config, watcher } = setup();
    await watcher?.start();
    await watcher?.idle();
    const body = await (await app(config, watcher).request('/api/watcher/self')).json();
    expect(body.interoception).toMatchObject({
      breakerOpen: [],
      budgetUsedToday: { notice: 0, integrate: 0, tokens: 0, usd: 0 },
    });
    expect(body.attention).toMatchObject({ phase: 'sense', focusNeuronIds: [] });
    expect(body.introspection).toEqual([]);
    expect(body.subjects).toEqual([]);
    await watcher?.stop();
  });

  it('GET /self and POST /introspect are 404 when off and for tenants', async () => {
    const off = setup(false);
    expect((await app(off.config, undefined).request('/api/watcher/self')).status).toBe(404);
    expect((await post(app(off.config, undefined), '/api/watcher/introspect')).status).toBe(404);
    const { config, watcher } = setup();
    expect((await app(config, watcher, 't1').request('/api/watcher/self')).status).toBe(404);
    expect((await post(app(config, watcher, 't1'), '/api/watcher/introspect')).status).toBe(404);
  });
});

describe('watcher routes: pass records (O6)', () => {
  it('lists the records newest first without prompts, reads one, admin only', async () => {
    const { PassRecords, passesDir } = await import('../../../src/watcher/pass-records');
    const { config, watcher } = setup();
    const records = new PassRecords({
      dir: passesDir(join(root, 'data', 'watcher')),
      now: () => t,
    });
    const rec = {
      caller: 'watcher:notice' as const,
      tier: 'notice' as const,
      model: 'm',
      backend: 'claude-cli',
      ok: true,
      durationMs: 10,
      prompt: { system: 'S', user: 'U' },
      response: 'R',
    };
    const first = records.write(rec) as string;
    t += 1000;
    const second = records.write({ ...rec, caller: 'watcher:integrate', tier: 'integrate' });

    const a = app(config, watcher);
    const res = await a.request('/api/watcher/passes?limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { passes: Array<Record<string, unknown>> };
    expect(body.passes.map((p) => p.id)).toEqual([second, first]);
    expect(body.passes[0]).not.toHaveProperty('prompt');

    const one = await a.request(`/api/watcher/passes/${first}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { pass: { response: string } }).pass.response).toBe('R');
    expect((await a.request('/api/watcher/passes/notice-1-ffff')).status).toBe(404);
    expect((await a.request('/api/watcher/passes/..%2F..%2Fconfig')).status).toBe(404);

    const tenant = app(config, watcher, 't1');
    expect((await tenant.request('/api/watcher/passes')).status).toBe(404);
    expect((await tenant.request(`/api/watcher/passes/${first}`)).status).toBe(404);
  });

  it('404 with enabled: false while the watcher is off', async () => {
    const { config } = setup(false);
    const res = await app(config, undefined).request('/api/watcher/passes');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
  });
});

describe('POST /api/watcher/maintain', () => {
  it('is 404 when off and for a tenant', async () => {
    const off = setup(false);
    expect((await post(app(off.config, undefined), '/api/watcher/maintain')).status).toBe(404);
    const { config, watcher } = setup();
    expect((await post(app(config, watcher, 't1'), '/api/watcher/maintain')).status).toBe(404);
  });

  it('is 409 while the watcher is asleep', async () => {
    const { config, watcher } = setup();
    const res = await post(app(config, watcher), '/api/watcher/maintain');
    expect(res.status).toBe(409);
  });

  it('runs maintenance now and returns what it did; 409 while a run is in flight', async () => {
    const { config, watcher } = setup();
    if (!watcher) throw new Error('no watcher');
    await watcher.start();
    await watcher.idle();
    const a = app(config, watcher, '__admin__');
    const inFlight = watcher.maintainNow();
    expect((await post(a, '/api/watcher/maintain')).status).toBe(409);
    await inFlight;
    const res = await post(a, '/api/watcher/maintain');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forgotten: number;
      link: unknown;
      at: string;
    };
    expect(body.forgotten).toBe(0);
    expect('link' in body).toBe(true);
    expect(body.at).toBe(new Date(t).toISOString());
    await watcher.stop();
  });

  it('answers promptly with the forget result while the embedding backfill hangs', async () => {
    const born = setup();
    if (!born.watcher) throw new Error('no watcher');
    await born.watcher.start();
    await born.watcher.idle();
    await born.watcher.stop();
    t += 1000;
    const { config, watcher } = setup(true, {
      stopTimeoutMs: 30,
      embed: () => new Promise<number[]>(() => {}),
    });
    if (!watcher) throw new Error('no watcher');
    await watcher.start();
    const res = await Promise.race([
      post(app(config, watcher, '__admin__'), '/api/watcher/maintain'),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 1000)),
    ]);
    if (res === 'hung') throw new Error('the route waited on the hanging embed');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { forgotten: number; link: unknown; at: string };
    expect(typeof body.forgotten).toBe('number');
    expect(body.link).toBeNull();
    expect(body.at).toBe(new Date(t).toISOString());
    await watcher.stop();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { statsRoutes } from '../../src/web/routes/stats';
import { removeTempDir } from '../helpers/temp-dir';
import { type StatsFixture, createStatsFixture } from './fixture';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

let fx: StatsFixture;
beforeEach(() => {
  fx = createStatsFixture();
});
afterEach(() => removeTempDir(fx.dir));

function makeApp(tenantId?: string, extra: Record<string, unknown> = {}) {
  const app = new Hono();
  if (tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  app.route(
    '/api/stats',
    statsRoutes({
      config: fx.config,
      botManager: {} as never,
      logger: noopLogger,
      now: () => fx.now,
      ...extra,
    })
  );
  return app;
}

describe('statsRoutes — fleet', () => {
  it('GET /fleet returns every bot with the default 7d window', async () => {
    const res = await makeApp().request('/api/stats/fleet');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window).toBe('7d');
    expect(body.bots.map((b: { botId: string }) => b.botId)).toEqual(['b1', 'b2', 'b3']);
    expect(body.totals.llmCalls).toBe(3);
  });
  it('honours ?window= and falls back to 7d on garbage', async () => {
    const app = makeApp();
    expect((await (await app.request('/api/stats/fleet?window=24h')).json()).window).toBe('24h');
    expect((await (await app.request('/api/stats/fleet?window=zzz')).json()).window).toBe('7d');
  });
  it('GET / is an alias of /fleet', async () => {
    const res = await makeApp().request('/api/stats');
    expect(res.status).toBe(200);
    expect((await res.json()).bots).toHaveLength(3);
  });
  it('caches aggregations for a minute', async () => {
    const app = makeApp();
    expect((await (await app.request('/api/stats/fleet')).json()).totals.llmCalls).toBe(3);
    const file = join(
      fx.dir,
      'llm-query-log',
      'b1',
      `${new Date(fx.now).toISOString().slice(0, 10)}.jsonl`
    );
    appendFileSync(
      file,
      `${JSON.stringify({ timestamp: new Date(fx.now).toISOString(), botId: 'b1', caller: 'planner', model: 'qwen', backend: 'ollama', durationMs: 1, success: true })}\n`
    );
    expect((await (await app.request('/api/stats/fleet')).json()).totals.llmCalls).toBe(3);
  });
});

describe('statsRoutes — tenant scoping', () => {
  it('a tenant only sees its own bots', async () => {
    const app = makeApp('t2');
    const body = await (await app.request('/api/stats/fleet')).json();
    expect(body.bots.map((b: { botId: string }) => b.botId)).toEqual(['b3']);
    expect((await app.request('/api/stats/bots/b1')).status).toBe(404);
    expect((await app.request('/api/stats/bots/b3')).status).toBe(200);
    const infra = await (await app.request('/api/stats/infra')).json();
    expect(infra.telegram.map((t: { botId: string }) => t.botId)).toEqual(['b3']);
    const beh = await (await app.request('/api/stats/behaviour')).json();
    expect(beh.collaboration.nodes).toEqual([{ botId: 'b3' }]);
  });
  it('admin sees everything', async () => {
    const body = await (await makeApp('__admin__').request('/api/stats/fleet')).json();
    expect(body.bots).toHaveLength(3);
  });
});

describe('statsRoutes — bot detail, behaviour, infra', () => {
  it('GET /bots/:botId returns the detail shape and 404 for unknown ids', async () => {
    const app = makeApp();
    const res = await app.request('/api/stats/bots/b1?window=30d');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.botId).toBe('b1');
    expect(body.window).toBe('30d');
    expect(body.goalsDetail).toHaveLength(3);
    expect(body.asks).toHaveLength(2);
    expect((await app.request('/api/stats/bots/nope')).status).toBe(404);
  });
  it('GET /behaviour and /infra return their shapes', async () => {
    const app = makeApp();
    const beh = await (await app.request('/api/stats/behaviour?window=24h')).json();
    expect(beh.window).toBe('24h');
    expect(beh.askEconomics.buckets).toHaveLength(4);
    expect(beh.mesh.total).toBe(1);
    const infra = await (await app.request('/api/stats/infra')).json();
    expect(infra.cron).toHaveLength(1);
    expect(Array.isArray(infra.boots)).toBe(true);
    expect(typeof infra.logBytes).toBe('number');
  });
  it('karma service is used for scores when provided', async () => {
    const app = makeApp(undefined, { karmaService: { getScore: () => 61 } });
    const body = await (await app.request('/api/stats/bots/b1')).json();
    expect(body.karma.score).toBe(61);
  });
});

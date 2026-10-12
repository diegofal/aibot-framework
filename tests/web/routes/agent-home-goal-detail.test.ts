import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { Hono } from 'hono';
import type { CycleDetailResponse, GoalDetailResponse } from '../../../src/stats/types';
import { agentHomeRoutes } from '../../../src/web/routes/agent-home';
import {
  type GoalDetailFixture,
  LAB_GOAL,
  createGoalDetailFixture,
} from '../../stats/goal-detail-fixture';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

let fx: GoalDetailFixture;
beforeEach(() => {
  fx = createGoalDetailFixture();
});
afterEach(() => rmSync(fx.dir, { recursive: true, force: true }));

function makeApp(tenantId?: string) {
  const app = new Hono();
  if (tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  app.route(
    '/api/agents',
    agentHomeRoutes({
      config: fx.config,
      botManager: { getAgentLoopState: () => ({ botSchedules: [] }) as never },
      logger: noopLogger,
      now: () => fx.now,
    })
  );
  return app;
}

const get = (app: Hono, query: string) => app.request(`/api/agents/g1/goals/detail?${query}`);

describe('GET /api/agents/:id/goals/detail', () => {
  it('returns the goal detail by id', async () => {
    const res = await get(makeApp(), 'id=g-lab00001&days=14');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GoalDetailResponse;
    expect(body.goal.text).toBe(LAB_GOAL);
    expect(body.days).toBe(14);
    expect(body.cycles[0].attribution).toBe('exact');
  });

  it('finds the goal by exact title too', async () => {
    const res = await get(makeApp(), `title=${encodeURIComponent(LAB_GOAL)}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as GoalDetailResponse).goal.id).toBe('g-lab00001');
  });

  it('400 without a key, 404 for unknown goals and bots outside the tenant', async () => {
    expect((await get(makeApp(), '')).status).toBe(400);
    expect((await get(makeApp(), 'id=g-nope')).status).toBe(404);
    expect((await makeApp().request('/api/agents/nope/goals/detail?id=x')).status).toBe(404);
    expect((await get(makeApp('t9'), 'id=g-lab00001')).status).toBe(404);
  });

  it('a board move drops the cached detail', async () => {
    const app = makeApp();
    const byTitle = `title=${encodeURIComponent(LAB_GOAL)}`;
    await get(app, byTitle);
    await app.request('/api/agents/g1/goals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: LAB_GOAL, status: 'blocked' }),
    });
    // By title: on main, serializeGoals does not keep the id line yet (instrumentation adds it).
    const body = (await (await get(app, byTitle)).json()) as GoalDetailResponse;
    expect(body.goal.status).toBe('blocked');
  });
});

describe('GET /api/agents/:id/cycles/:cycleId', () => {
  it('returns one cycle with its goal', async () => {
    const res = await makeApp().request('/api/agents/g1/cycles/c-exact');
    expect(res.status).toBe(200);
    const body = (await res.json()) as CycleDetailResponse;
    expect(body.cycle.cycleId).toBe('c-exact');
    expect(body.goal).toEqual({ id: 'g-lab00001', title: LAB_GOAL });
  });

  it('404 for an unknown cycle, an unknown bot, and a bot outside the tenant', async () => {
    expect((await makeApp().request('/api/agents/g1/cycles/c-nope')).status).toBe(404);
    expect((await makeApp().request('/api/agents/nope/cycles/c-exact')).status).toBe(404);
    expect((await makeApp('t9').request('/api/agents/g1/cycles/c-exact')).status).toBe(404);
  });
});

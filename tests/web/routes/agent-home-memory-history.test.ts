import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { Hono } from 'hono';
import { appendSoulEvent } from '../../../src/bot/soul-events';
import { type MemoryHistoryResponse, agentHomeRoutes } from '../../../src/web/routes/agent-home';
import { type GoalDetailFixture, createGoalDetailFixture } from '../../stats/goal-detail-fixture';

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

const at = (msAgo: number) => () => new Date(fx.now - msAgo);

describe('GET /api/agents/:id/memory-history', () => {
  it('returns soul events newest first, each with its why', async () => {
    appendSoulEvent(fx.soulDir, {
      file: 'MEMORY.md',
      op: 'consolidate',
      actor: 'system',
      summary: 'Merged 1 daily log into MEMORY.md.',
      now: at(3_600_000),
    });
    appendSoulEvent(fx.soulDir, {
      file: 'core-memory',
      op: 'facts-saved',
      actor: 'system',
      summary: 'Saved 1 fact from a conversation.',
      added: ['[general] synthetic fact'],
      conversation: 'bot:g1:private:1',
      now: at(60_000),
    });
    const res = await makeApp().request('/api/agents/g1/memory-history');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemoryHistoryResponse;
    expect(body.events.map((e) => e.op)).toEqual(['facts-saved', 'consolidate']);
    expect(body.events[0].why.what).toBe('Facts saved from a conversation');
    expect(body.events[1].why.what).toBe('Memory consolidated');
    expect(body.total).toBe(2);
  });

  it('honours limit and fills the cycle from the cycle log', async () => {
    for (let i = 0; i < 3; i++) {
      appendSoulEvent(fx.soulDir, {
        file: 'MEMORY.md',
        op: 'consolidate',
        actor: 'system',
        summary: `event ${i}`,
        cycleId: 'c-exact',
      });
    }
    const body = (await (
      await makeApp().request('/api/agents/g1/memory-history?limit=2')
    ).json()) as MemoryHistoryResponse;
    expect(body.events.map((e) => e.summary)).toEqual(['event 2', 'event 1']);
    expect(body.total).toBe(3);
    expect(body.events[0].why.cycle?.plan).toBe('Draft the October lab');
  });

  it('an agent with no log gets an empty list; other tenants and unknown bots get 404', async () => {
    const body = (await (
      await makeApp().request('/api/agents/g1/memory-history')
    ).json()) as MemoryHistoryResponse;
    expect(body.events).toEqual([]);
    expect((await makeApp().request('/api/agents/nope/memory-history')).status).toBe(404);
    expect((await makeApp('t9').request('/api/agents/g1/memory-history')).status).toBe(404);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { LessonStore } from '../../../src/bot/self-improve/store';
import type { Lesson } from '../../../src/bot/self-improve/types';
import { type LessonsResponse, agentHomeRoutes } from '../../../src/web/routes/agent-home';
import { makeBot } from '../../stats/fixture';
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

const lesson = (id: string, createdAt: string, over: Partial<Lesson> = {}): Lesson => ({
  id,
  classKey: 'file_read:file-not-found',
  tool: 'file_read',
  errorClass: 'file-not-found',
  text: `lesson ${id}`,
  textSource: 'model',
  evidence: [],
  source: 'own',
  status: 'active',
  createdAt,
  updatedAt: createdAt,
  baseline: { failures: 4, calls: 10, rate: 0.4, sinceMs: 0, untilMs: 1 },
  ...over,
});

async function get(app: Hono, path = '/api/agents/g1/lessons') {
  return app.request(path);
}

describe('GET /api/agents/:id/lessons', () => {
  it('unknown bot → 404', async () => {
    expect((await get(makeApp(), '/api/agents/nope/lessons')).status).toBe(404);
  });

  it('tenant-scoped: the owning tenant sees it, another tenant gets 404', async () => {
    fx.bot.tenantId = 't1';
    expect((await get(makeApp('t1'))).status).toBe(200);
    expect((await get(makeApp('t9'))).status).toBe(404);
  });

  it('no LESSONS.json → empty lists, the resolved config, off by default', async () => {
    const res = await get(makeApp());
    expect(res.status).toBe(200);
    const body = (await res.json()) as LessonsResponse;
    expect(body.lessons).toEqual([]);
    expect(body.suppressed).toEqual([]);
    expect(body.enabled).toBe(false);
    expect(body.config.minDrop).toBe(0.5);
  });

  it('an empty or unreadable file reads as no lessons', async () => {
    mkdirSync(fx.soulDir, { recursive: true });
    writeFileSync(join(fx.soulDir, 'LESSONS.json'), '');
    const body = (await (await get(makeApp())).json()) as LessonsResponse;
    expect(body.lessons).toEqual([]);
  });

  it('enabled reflects the bot override over the global default', async () => {
    (fx.config as { agentLoop?: unknown }).agentLoop = {
      ...(fx.config.agentLoop ?? {}),
      selfImprove: { enabled: false, minDrop: 0.4 },
    };
    fx.bot.agentLoop = { ...(fx.bot.agentLoop ?? {}), selfImprove: { enabled: true } } as never;
    const body = (await (await get(makeApp())).json()) as LessonsResponse;
    expect(body.enabled).toBe(true);
    expect(body.config.enabled).toBe(true);
    expect(body.config.minDrop).toBe(0.4);
  });

  it('lessons newest first, each with its why; the cycle row and borrowed name filled in', async () => {
    fx.config.bots.push(makeBot({ id: 'b2', name: 'Scout' }));
    new LessonStore(fx.soulDir).write({
      version: 1,
      lessons: [
        lesson('l-00000001', new Date(fx.t.exact + 60_000).toISOString(), { cycleId: 'c-exact' }),
        lesson('l-00000003', new Date(fx.now).toISOString(), {
          source: 'borrowed',
          borrowedFrom: { botId: 'b2', lessonId: 'l-99999999' },
        }),
        lesson('l-00000002', new Date(fx.t.exact + 3_600_000).toISOString(), { status: 'retired' }),
      ],
      suppressed: [
        { classKey: 'file_read:read-a-directory', reason: 'tool problem', since: 'x', bots: [] },
      ],
    });
    const body = (await (await get(makeApp())).json()) as LessonsResponse;
    expect(body.lessons.map((l) => l.id)).toEqual(['l-00000003', 'l-00000002', 'l-00000001']);
    expect(body.lessons[0].why.what).toBe('Lesson: lesson l-00000003');
    expect(body.lessons[0].why.notes).toContainEqual({
      label: 'Borrowed from',
      text: 'Scout (lesson l-99999999)',
    });
    expect(body.lessons[1].why.outcome).toStartWith('Retired');
    expect(body.lessons[2].why.cycle?.plan).toBe('Draft the October lab');
    expect(body.suppressed.map((s) => s.classKey)).toEqual(['file_read:read-a-directory']);
  });
});

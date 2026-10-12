/**
 * GET /api/proactive — the fleet's proactive messages from the tool audit,
 * newest first, tenant-scoped, each with its `why`. Synthetic fixtures only.
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { ToolAuditEntry } from '../../../src/bot/tool-audit-log';
import type { BotConfig, Config } from '../../../src/config';
import { proactiveRoutes } from '../../../src/web/routes/proactive';
import type { CycleRow } from '../../../src/why/cycle-index';
import { WhySchema } from '../../../src/why/types';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

const NOW = Date.parse('2026-10-11T18:00:00Z');

function entry(botId: string, timestamp: string, over: Partial<ToolAuditEntry> = {}) {
  return {
    timestamp,
    botId,
    chatId: 0,
    toolName: 'send_proactive_message',
    args: { chatId: 'operator', message: `synthetic from ${botId} at ${timestamp}` },
    success: true,
    result: 'Message sent to the operator (chat 1)',
    durationMs: 5,
    retryAttempts: 0,
    ...over,
  } as ToolAuditEntry;
}

const AUDIT: Record<string, ToolAuditEntry[]> = {
  b1: [
    entry('b1', '2026-10-11T10:00:00.000Z', { cycleId: 'c-1', goalId: 'g-1' }),
    entry('b1', '2026-10-11T11:00:00.000Z', {
      success: false,
      failureKind: 'policy',
      result:
        'Proactive send throttled: b1 may send again at 2026-10-11T11:30:00.000Z. Per-bot cooldown 60m.',
    }),
    entry('b1', '2026-10-11T11:30:00.000Z', { toolName: 'web_fetch', args: { url: 'x' } }),
  ],
  b2: [
    entry('b2', '2026-10-11T12:00:00.000Z', {
      args: { chatId: '777', message: 'synthetic to a user' },
      success: false,
      result: 'Failed to send: chat not found',
    }),
  ],
  b3: [entry('b3', '2026-10-11T13:00:00.000Z')],
};

const CYCLES: Record<string, CycleRow[]> = {
  b1: [
    {
      cycleId: 'c-1',
      startedAt: '2026-10-11T09:59:00.000Z',
      endedAt: '2026-10-11T10:05:00.000Z',
      planSummary: 'Tell the operator about the new roles',
      goalId: 'g-1',
      goalTitle: 'Find remote roles',
    },
  ],
};

function makeApp(opts: { tenantId?: string; failBot?: string } = {}) {
  const auditReads: string[] = [];
  const cycleReads: string[] = [];
  const config = {
    operator: { telegramChatId: 1 },
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
    '/api/proactive',
    proactiveRoutes({
      config,
      logger: noopLogger,
      now: () => NOW,
      readToolAudit: (botId, sinceMs, untilMs) => {
        auditReads.push(botId);
        if (botId === opts.failBot) throw new Error('disk');
        return (AUDIT[botId] ?? []).filter((e) => {
          const t = Date.parse(e.timestamp);
          return t >= sinceMs && t <= untilMs;
        });
      },
      readCycles: (botId) => {
        cycleReads.push(botId);
        return CYCLES[botId] ?? [];
      },
      avatarUrlFor: (id) => (id === 'b1' ? '/api/agents/b1/avatar?v=1' : null),
    })
  );
  return { app, auditReads, cycleReads };
}

async function get(app: Hono, path: string) {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/proactive', () => {
  it('lists the fleet newest first, each with a valid why', async () => {
    const { app, cycleReads } = makeApp();
    const { status, body } = await get(app, '/api/proactive');
    expect(status).toBe(200);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs.map((m) => `${m.botId}@${m.sentAt}`)).toEqual([
      'b3@2026-10-11T13:00:00.000Z',
      'b2@2026-10-11T12:00:00.000Z',
      'b1@2026-10-11T11:00:00.000Z',
      'b1@2026-10-11T10:00:00.000Z',
    ]);
    for (const m of msgs) expect(WhySchema.safeParse(m.why).success).toBe(true);
    // One cycle-log read per bot that has a recorded cycle.
    expect(cycleReads).toEqual(['b1']);
    expect(body.hasMore).toBe(false);
  });

  it('carries recipient, delivery and why per message', async () => {
    const { body } = await get(makeApp().app, '/api/proactive');
    const msgs = body.messages as Array<Record<string, any>>;
    const delivered = msgs.find((m) => m.sentAt === '2026-10-11T10:00:00.000Z');
    expect(delivered).toMatchObject({
      botId: 'b1',
      botName: 'Bot One',
      avatarUrl: '/api/agents/b1/avatar?v=1',
      recipient: 'operator',
      toOperator: true,
      status: 'delivered',
      delivered: true,
      message: 'synthetic from b1 at 2026-10-11T10:00:00.000Z',
    });
    expect(delivered?.why.cycle.plan).toBe('Tell the operator about the new roles');
    expect(delivered?.why.goal).toEqual({ id: 'g-1', title: 'Find remote roles' });

    const refused = msgs.find((m) => m.sentAt === '2026-10-11T11:00:00.000Z');
    expect(refused).toMatchObject({ status: 'refused', delivered: false });
    expect(refused?.reason).toContain('Per-bot cooldown 60m');
    expect(refused?.why.rule).toBe('One proactive message per agent every 60 min.');
    expect(refused?.why.missing).toContain('No record of the cycle');

    const failed = msgs.find((m) => m.botId === 'b2');
    expect(failed).toMatchObject({
      recipient: '777',
      toOperator: false,
      status: 'failed',
      delivered: false,
      reason: 'Failed to send: chat not found',
    });
  });

  it('scopes to the tenant', async () => {
    const { app, auditReads } = makeApp({ tenantId: 't2' });
    const { body } = await get(app, '/api/proactive');
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs.map((m) => m.botId)).toEqual(['b3']);
    expect(auditReads).toEqual(['b3']);
  });

  it('pages with limit and the before cursor', async () => {
    const { app } = makeApp();
    const first = await get(app, '/api/proactive?limit=2');
    expect((first.body.messages as unknown[]).length).toBe(2);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextBefore).toBe('2026-10-11T12:00:00.000Z');
    const next = await get(
      app,
      `/api/proactive?limit=2&before=${encodeURIComponent(String(first.body.nextBefore))}`
    );
    const msgs = next.body.messages as Array<Record<string, unknown>>;
    expect(msgs.map((m) => m.sentAt)).toEqual([
      '2026-10-11T11:00:00.000Z',
      '2026-10-11T10:00:00.000Z',
    ]);
    expect(next.body.hasMore).toBe(false);
  });

  it('rejects a bad cursor', async () => {
    expect((await get(makeApp().app, '/api/proactive?before=nope')).status).toBe(400);
  });

  it('a bot whose audit cannot be read is skipped, not fatal', async () => {
    const { body } = await get(makeApp({ failBot: 'b1' }).app, '/api/proactive');
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs.map((m) => m.botId)).toEqual(['b3', 'b2']);
  });
});

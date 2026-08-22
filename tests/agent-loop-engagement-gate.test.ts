import { describe, expect, mock, test } from 'bun:test';
import type { AgentLoopResult } from '../src/bot/agent-loop';
import {
  HUMAN_INBOUND_HOOK,
  type RecentAction,
  buildRecentActionsDigest,
  countFeedbackSignals,
  countOutputsSince,
  countProductionOutputsSince,
  detectUnconsumedOutput,
  evaluateEngagementGate,
  resolveDurableOutputCount,
} from '../src/bot/agent-loop-utils';
import { AgentScheduler } from '../src/bot/agent-scheduler';
import { HookEmitter } from '../src/bot/hooks';
import { BotAgentLoopOverrideSchema } from '../src/config';

const HOUR = 3_600_000;

function makeActions(summaries: string[]): RecentAction[] {
  return summaries.map((s, i) => ({
    cycle: i + 1,
    timestamp: Date.now() - (summaries.length - i) * HOUR,
    tools: [],
    planSummary: s,
  }));
}

const fiveContent = makeActions([
  'Create file A',
  'Create file B',
  'Create file C',
  'Create file D',
  'Create file E',
]);

describe('engagementGate config default', () => {
  test('mode defaults to hard, soft stays selectable per bot', () => {
    expect(BotAgentLoopOverrideSchema.parse({ engagementGate: {} }).engagementGate?.mode).toBe(
      'hard'
    );
    expect(
      BotAgentLoopOverrideSchema.parse({ engagementGate: { mode: 'soft' } }).engagementGate?.mode
    ).toBe('soft');
  });
});

describe('detectUnconsumedOutput with external feedback', () => {
  test('external human feedback counts toward feedbackCount and lifts the gate', () => {
    const without = detectUnconsumedOutput(fiveContent, 5);
    expect(without.gateTriggered).toBe(true);
    expect(without.feedbackCount).toBe(0);

    const withExternal = detectUnconsumedOutput(fiveContent, 5, 2);
    expect(withExternal.gateTriggered).toBe(false);
    expect(withExternal.feedbackCount).toBe(2);
    expect(withExternal.externalFeedbackCount).toBe(2);
    expect(withExternal.outputCount).toBe(5);
  });

  test('external feedback defaults to 0 (backward compatible)', () => {
    expect(detectUnconsumedOutput(fiveContent, 5).externalFeedbackCount).toBe(0);
  });
});

describe('detectUnconsumedOutput with a durable output count', () => {
  test('REGRESSION: gates on the durable count even when recentActions is empty (restart)', () => {
    // The in-memory window resets on every container restart; the ledger does not.
    const r = detectUnconsumedOutput([], 5, 0, 65);
    expect(r.outputCount).toBe(65);
    expect(r.outputSource).toBe('durable');
    expect(r.feedbackCount).toBe(0);
    expect(r.gateTriggered).toBe(true);
  });

  test('one real feedback event un-gates the durable count', () => {
    const r = detectUnconsumedOutput([], 5, 1, 65);
    expect(r.gateTriggered).toBe(false);
    expect(r.feedbackCount).toBe(1);
  });

  test('a durable count below the threshold does not gate', () => {
    expect(detectUnconsumedOutput([], 5, 0, 4).gateTriggered).toBe(false);
  });

  test('falls back to the in-memory window when no durable count is supplied', () => {
    const r = detectUnconsumedOutput(fiveContent, 5);
    expect(r.outputSource).toBe('recent-actions');
    expect(r.outputCount).toBe(5);
  });

  test('a durable count of 0 wins over a non-empty window (nothing produced since feedback)', () => {
    const r = detectUnconsumedOutput(fiveContent, 5, 0, 0);
    expect(r.outputCount).toBe(0);
    expect(r.outputSource).toBe('durable');
    expect(r.gateTriggered).toBe(false);
  });
});

describe('detectUnconsumedOutput no longer sniffs keywords', () => {
  test('a plan summary that merely mentions feedback does not un-gate the bot', () => {
    const mentions = makeActions([
      'Create draft A and ask the operator for feedback',
      'Create draft B and ask the operator for feedback',
      'Create draft C and ask the operator for feedback',
      'Create draft D and ask the operator for feedback',
      'Create draft E and ask the operator for feedback',
    ]);
    const r = detectUnconsumedOutput(mentions, 5);
    expect(r.feedbackCount).toBe(0);
    expect(r.gateTriggered).toBe(true);
  });

  test('an ASSESSMENT the bot performs on itself is not feedback from anyone', () => {
    const r = detectUnconsumedOutput(
      [...fiveContent, ...makeActions(['Review and evaluate the impact of the published guides'])],
      5
    );
    expect(r.feedbackCount).toBe(0);
    expect(r.gateTriggered).toBe(true);
  });
});

describe('countOutputsSince', () => {
  const now = Date.now();
  const entries = [
    { timestamp: now - 3 * HOUR, type: 'CONTENT' as const },
    { timestamp: now - 2 * HOUR, type: 'OUTREACH' as const },
    { timestamp: now - 2 * HOUR, type: 'RESEARCH' as const },
    { timestamp: now - 2 * HOUR, type: 'MAINTENANCE' as const },
    { timestamp: now - 2 * HOUR, type: 'IDLE' as const },
    { timestamp: now - 10 * HOUR, type: 'CONTENT' as const },
  ];

  test('counts only CONTENT and OUTREACH entries strictly after the anchor', () => {
    expect(countOutputsSince(entries, now - 4 * HOUR)).toBe(2);
  });

  test('excludes entries at or before the anchor', () => {
    expect(countOutputsSince(entries, now - 2 * HOUR)).toBe(0);
  });

  test('an empty ledger counts zero', () => {
    expect(countOutputsSince([], 0)).toBe(0);
  });
});

describe('countProductionOutputsSince', () => {
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString();
  const entries = [
    { timestamp: iso(now - HOUR), action: 'create' },
    { timestamp: iso(now - HOUR), action: 'edit' },
    { timestamp: iso(now - HOUR), action: 'archive' },
    { timestamp: iso(now - HOUR), action: 'delete' },
    { timestamp: iso(now - 40 * HOUR), action: 'create' },
    { timestamp: 'not-a-date', action: 'create' },
  ];

  test('counts create/edit changelog entries after the anchor only', () => {
    expect(countProductionOutputsSince(entries, now - 24 * HOUR)).toBe(2);
  });

  test('ignores unparseable timestamps and non-content actions', () => {
    expect(countProductionOutputsSince(entries, 0)).toBe(3);
  });
});

describe('resolveDurableOutputCount', () => {
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString();

  test('prefers the outcome ledger', () => {
    const n = resolveDurableOutputCount(
      {
        outcomeEntries: [{ timestamp: now - HOUR, type: 'CONTENT' }],
        productionEntries: [{ timestamp: iso(now - HOUR), action: 'create' }],
      },
      now - 24 * HOUR
    );
    expect(n).toBe(1);
  });

  test('falls back to the production changelog when the ledger has nothing', () => {
    const n = resolveDurableOutputCount(
      {
        outcomeEntries: [],
        productionEntries: [
          { timestamp: iso(now - HOUR), action: 'create' },
          { timestamp: iso(now - HOUR), action: 'edit' },
        ],
      },
      now - 24 * HOUR
    );
    expect(n).toBe(2);
  });

  test('returns 0 with no sources at all', () => {
    expect(resolveDurableOutputCount({}, 0)).toBe(0);
  });
});

describe('buildRecentActionsDigest with external feedback', () => {
  test('omits the ENGAGEMENT GAP warning once external feedback exists', () => {
    expect(buildRecentActionsDigest(fiveContent)).toContain('ENGAGEMENT GAP');
    expect(buildRecentActionsDigest(fiveContent, { externalFeedbackCount: 1 })).not.toContain(
      'ENGAGEMENT GAP'
    );
  });

  test('reports the durable output count in the ENGAGEMENT GAP warning', () => {
    const digest = buildRecentActionsDigest(makeActions(['Create file A']), {
      durableOutputCount: 65,
    });
    expect(digest).toContain('ENGAGEMENT GAP');
    expect(digest).toContain('65 outputs');
  });
});

describe('countFeedbackSignals', () => {
  const now = Date.now();
  const since = now - 24 * HOUR;
  const iso = (t: number) => new Date(t).toISOString();

  test('counts production approvals and rejections evaluated since the window start', () => {
    const productionsService = {
      getChangelog: mock(() => [
        { id: '1', evaluation: { status: 'approved', evaluatedAt: iso(now - HOUR) } },
        { id: '2', evaluation: { status: 'rejected', evaluatedAt: iso(now - 2 * HOUR) } },
        { id: '3', evaluation: { status: 'approved', evaluatedAt: iso(now - 48 * HOUR) } },
        { id: '4', evaluation: { evaluatedAt: iso(now - HOUR) } }, // thread only, no verdict
        { id: '5' },
      ]),
    };
    const r = countFeedbackSignals({ productionsService: productionsService as any }, 'b1', since);
    expect(r.productionEvaluations).toBe(2);
    expect(r.total).toBe(2);
    expect(productionsService.getChangelog).toHaveBeenCalledWith('b1', expect.anything());
  });

  test('counts answered ask_human questions, agent feedback and human messages from schedule events', () => {
    const r = countFeedbackSignals(
      {
        feedbackEvents: [
          { timestamp: now - HOUR, source: 'ask_human' },
          { timestamp: now - HOUR, source: 'agent_feedback' },
          { timestamp: now - HOUR, source: 'human_message' },
          { timestamp: now - 30 * HOUR, source: 'ask_human' }, // outside window
        ],
      },
      'b1',
      since
    );
    expect(r.askHumanAnswers).toBe(1);
    expect(r.agentFeedback).toBe(1);
    expect(r.humanMessages).toBe(1);
    expect(r.total).toBe(3);
  });

  test('counts human-role dashboard messages since the window start', () => {
    const conversationsService = {
      listConversations: mock(() => [
        { id: 'c1', updatedAt: iso(now - HOUR) },
        { id: 'c2', updatedAt: iso(now - 40 * HOUR) }, // stale — not even opened
      ]),
      getMessages: mock(() => [
        { role: 'bot', content: 'q', createdAt: iso(now - 3 * HOUR) },
        { role: 'human', content: 'a', createdAt: iso(now - 2 * HOUR) },
        { role: 'human', content: 'old', createdAt: iso(now - 30 * HOUR) },
      ]),
    };
    const r = countFeedbackSignals(
      { conversationsService: conversationsService as any },
      'b1',
      since
    );
    expect(r.humanMessages).toBe(1);
    expect(conversationsService.getMessages).toHaveBeenCalledTimes(1);
  });

  test('reports the most recent feedback timestamp across every source', () => {
    const r = countFeedbackSignals(
      {
        productionsService: {
          getChangelog: () => [
            { evaluation: { status: 'approved', evaluatedAt: iso(now - HOUR) } },
          ],
        } as any,
        feedbackEvents: [
          { timestamp: now - 3 * HOUR, source: 'human_message' },
          { timestamp: now - 30 * HOUR, source: 'ask_human' },
        ],
      },
      'b1',
      since
    );
    expect(r.lastFeedbackAt).toBe(now - HOUR);
  });

  test('lastFeedbackAt is null when nothing was received in the window', () => {
    expect(countFeedbackSignals({}, 'b1', since).lastFeedbackAt).toBeNull();
  });

  test('tolerates missing services and throwing services', () => {
    expect(countFeedbackSignals({}, 'b1', since).total).toBe(0);
    const broken = {
      productionsService: {
        getChangelog: () => {
          throw new Error('disk');
        },
      } as any,
    };
    expect(countFeedbackSignals(broken, 'b1', since).total).toBe(0);
  });
});

describe('evaluateEngagementGate', () => {
  const triggered = detectUnconsumedOutput(fiveContent, 5);

  test('hard mode blocks a CONTENT plan with the canonical summary', () => {
    const r = evaluateEngagementGate({
      plan: ['Write a new guide and create docs/guide.md'],
      engagement: triggered,
      mode: 'hard',
      enabled: true,
    });
    expect(r.blocked).toBe(true);
    expect(r.actionType).toBe('CONTENT');
    expect(r.summary).toBe(
      'Engagement gate: content blocked until feedback (5 outputs, 0 feedback)'
    );
  });

  test('hard mode lets OUTREACH and ASSESSMENT plans through', () => {
    expect(
      evaluateEngagementGate({
        plan: ['Use ask_human to check in with the operator about the drafts'],
        engagement: triggered,
        mode: 'hard',
        enabled: true,
      }).blocked
    ).toBe(false);
    expect(
      evaluateEngagementGate({
        plan: ['Review and evaluate the impact of the published guides'],
        engagement: triggered,
        mode: 'hard',
        enabled: true,
      }).blocked
    ).toBe(false);
  });

  test('a durable-count gate blocks CONTENT and still lets OUTREACH through', () => {
    const durable = detectUnconsumedOutput([], 5, 0, 65);
    expect(
      evaluateEngagementGate({
        plan: ['Write a new guide and create docs/guide.md'],
        engagement: durable,
        mode: 'hard',
        enabled: true,
      })
    ).toMatchObject({
      blocked: true,
      summary: 'Engagement gate: content blocked until feedback (65 outputs, 0 feedback)',
    });
    expect(
      evaluateEngagementGate({
        plan: ['Use ask_human to check in with the operator about the drafts'],
        engagement: durable,
        mode: 'hard',
        enabled: true,
      }).blocked
    ).toBe(false);
  });

  test('soft mode never blocks', () => {
    expect(
      evaluateEngagementGate({
        plan: ['Write a new guide'],
        engagement: triggered,
        mode: 'soft',
        enabled: true,
      }).blocked
    ).toBe(false);
  });

  test('does not block when the gate is not triggered or disabled', () => {
    const calm = detectUnconsumedOutput(fiveContent, 5, 1);
    expect(
      evaluateEngagementGate({ plan: ['Write x'], engagement: calm, mode: 'hard', enabled: true })
        .blocked
    ).toBe(false);
    expect(
      evaluateEngagementGate({
        plan: ['Write x'],
        engagement: triggered,
        mode: 'hard',
        enabled: false,
      }).blocked
    ).toBe(false);
  });
});

describe('AgentScheduler feedback events and skippedReason', () => {
  function makeCtx(): any {
    return {
      hooks: new HookEmitter(),
      config: {
        agentLoop: {
          enabled: true,
          every: '5m',
          maxConcurrent: 2,
          strategist: { enabled: false, everyCycles: 3, minInterval: '1h' },
        },
        bots: [{ id: 'bot1', name: 'Bot 1' }],
      },
      runningBots: new Set(['bot1']),
      logger: { info: mock(), debug: mock(), warn: mock(), error: mock() },
      getBotLogger: () => ({ info: mock(), debug: mock(), warn: mock(), error: mock() }),
      getLLMClient: () => ({ backend: 'ollama' }),
    };
  }

  test('new schedules start with empty feedbackEvents and null skippedReason', () => {
    const scheduler = new AgentScheduler(makeCtx(), mock());
    scheduler.syncSchedules();
    const s = scheduler.getSchedule('bot1');
    expect(s?.feedbackEvents).toEqual([]);
    expect(s?.skippedReason).toBeNull();
  });

  test('recordFeedbackEvent appends and prunes events older than 7 days', () => {
    const scheduler = new AgentScheduler(makeCtx(), mock());
    scheduler.syncSchedules();
    const s = scheduler.getSchedule('bot1');
    if (!s) throw new Error('no schedule');
    s.feedbackEvents.push({ timestamp: Date.now() - 8 * 24 * HOUR, source: 'ask_human' });
    scheduler.recordFeedbackEvent('bot1', 'agent_feedback');
    expect(s.feedbackEvents).toHaveLength(1);
    expect(s.feedbackEvents[0].source).toBe('agent_feedback');
  });

  test('a human inbound message (requestImmediateRun) is recorded as feedback', () => {
    const scheduler = new AgentScheduler(makeCtx(), mock());
    scheduler.start();
    scheduler.syncSchedules();
    scheduler.requestImmediateRun('bot1');
    expect(scheduler.getSchedule('bot1')?.feedbackEvents.map((e) => e.source)).toEqual([
      'human_message',
    ]);
    scheduler.stop();
  });

  test('a human_inbound hook (REST/WS/WhatsApp/Discord) records exactly one feedback event', () => {
    const ctx = makeCtx();
    const scheduler = new AgentScheduler(ctx, mock());
    scheduler.start();
    scheduler.syncSchedules();

    ctx.hooks.emit(HUMAN_INBOUND_HOOK, {
      botId: 'bot1',
      channelKind: 'rest',
      chatId: '1',
      timestamp: Date.now(),
    });

    expect(scheduler.getSchedule('bot1')?.feedbackEvents.map((e) => e.source)).toEqual([
      'human_message',
    ]);
    scheduler.stop();
  });

  test('a Telegram message still records exactly one — the hook is not part of that path', () => {
    const ctx = makeCtx();
    const scheduler = new AgentScheduler(ctx, mock());
    scheduler.start();
    scheduler.syncSchedules();

    scheduler.requestImmediateRun('bot1');

    expect(scheduler.getSchedule('bot1')?.feedbackEvents).toHaveLength(1);
    scheduler.stop();
  });

  test('the hook listener is detached on stop (no cross-session leakage)', () => {
    const ctx = makeCtx();
    const scheduler = new AgentScheduler(ctx, mock());
    scheduler.start();
    scheduler.syncSchedules();
    scheduler.stop();

    expect(ctx.hooks.listenerCount(HUMAN_INBOUND_HOOK)).toBe(0);
  });

  test('an unknown botId on the hook records nothing', () => {
    const ctx = makeCtx();
    const scheduler = new AgentScheduler(ctx, mock());
    scheduler.start();
    scheduler.syncSchedules();

    ctx.hooks.emit(HUMAN_INBOUND_HOOK, {
      botId: 'ghost',
      channelKind: 'rest',
      chatId: '1',
      timestamp: Date.now(),
    });

    expect(scheduler.getSchedule('bot1')?.feedbackEvents).toEqual([]);
    scheduler.stop();
  });

  test('updateBotSchedule records skippedReason for skipped cycles and clears it otherwise', () => {
    const ctx = makeCtx();
    const scheduler = new AgentScheduler(ctx, mock());
    scheduler.syncSchedules();
    const base: AgentLoopResult = {
      botId: 'bot1',
      botName: 'Bot 1',
      status: 'skipped',
      summary: 'Agent loop: skipped — ollama circuit open until 2026-08-21T00:00:00.000Z',
      skippedReason: 'circuit-open:ollama',
      durationMs: 0,
      plannerReasoning: '',
      plan: [],
      toolCalls: [],
      strategistRan: false,
    };
    scheduler.updateBotSchedule('bot1', ctx.config.bots[0], base);
    expect(scheduler.getSchedule('bot1')?.skippedReason).toBe('circuit-open:ollama');
    expect(scheduler.buildScheduleInfos()[0].skippedReason).toBe('circuit-open:ollama');

    scheduler.updateBotSchedule('bot1', ctx.config.bots[0], {
      ...base,
      status: 'completed',
      skippedReason: undefined,
    });
    expect(scheduler.getSchedule('bot1')?.skippedReason).toBeNull();
  });
});

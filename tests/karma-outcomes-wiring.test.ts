/**
 * Outcome-based karma — wiring points and config surface.
 *
 * - config.karma.rewards / humanReplyCooldownHours defaults
 * - bot.traits { pinned, locked } schema
 * - AgentScheduler.recordFeedbackEvent → askAnswered / humanReply credits
 * - ProductionsService.evaluate → productionApproved / productionRejected
 * - AgentLoop non-idle cycle → novelAction (0 by default → no ledger entry)
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/bot/agent-loop';
import { AgentScheduler } from '../src/bot/agent-scheduler';
import { BotConfigSchema, GlobalAgentLoopConfigSchema, loadConfig } from '../src/config';
import { KarmaService } from '../src/karma/service';
import { ProductionsService } from '../src/productions/service';

function mockLogger(): any {
  const l: any = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
  l.child = () => l;
  return l;
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aibot-karma-wiring-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeKarma(overrides: Record<string, unknown> = {}): KarmaService {
  return new KarmaService(
    {
      enabled: true,
      baseDir: join(dataDir, 'karma'),
      initialScore: 50,
      decayDays: 30,
      dedupCooldownMinutes: 60,
      ...overrides,
    },
    mockLogger()
  );
}

// ── Config surface ──

describe('config: karma.rewards and bot.traits', () => {
  const { z } = require('zod');

  test('karma.rewards defaults to the outcome-based table and every key is overridable', () => {
    // KarmaConfigSchema is not exported; go through the top-level loader shape instead.
    const { KarmaConfigSchema } = require('../src/config');
    const parsed = KarmaConfigSchema.parse({});
    expect(parsed.rewards).toEqual({
      novelAction: 0,
      productionApproved: 3,
      productionRejected: -1,
      askAnswered: 2,
      humanReply: 3,
      collaborateCompleted: 0,
      toolError: -1,
    });
    expect(parsed.humanReplyCooldownHours).toBe(6);

    const custom = KarmaConfigSchema.parse({
      rewards: { novelAction: 1, toolError: -2 },
      humanReplyCooldownHours: 1,
    });
    expect(custom.rewards.novelAction).toBe(1);
    expect(custom.rewards.toolError).toBe(-2);
    expect(custom.rewards.humanReply).toBe(3);
    expect(custom.humanReplyCooldownHours).toBe(1);
    expect(z).toBeTruthy();
  });

  test('bot.traits accepts pinned (partial record) and locked (trait names)', () => {
    const bot = BotConfigSchema.parse({
      id: 'cryptik',
      name: 'Cryptik',
      skills: [],
      traits: { pinned: { sociability: 0.2 }, locked: ['independence'] },
    });
    expect(bot.traits?.pinned).toEqual({ sociability: 0.2 });
    expect(bot.traits?.locked).toEqual(['independence']);
    expect(BotConfigSchema.parse({ id: 'a', name: 'A', skills: [] }).traits).toBeUndefined();
  });

  test('bot.traits rejects unknown trait names and out-of-range pins', () => {
    expect(() =>
      BotConfigSchema.parse({ id: 'a', name: 'A', skills: [], traits: { locked: ['bravery'] } })
    ).toThrow();
    expect(() =>
      BotConfigSchema.parse({ id: 'a', name: 'A', skills: [], traits: { pinned: { depth: 7 } } })
    ).toThrow();
    expect(loadConfig).toBeDefined();
  });
});

// ── Scheduler: human feedback → engagement karma ──

describe('AgentScheduler.recordFeedbackEvent → karma', () => {
  function makeCtx(): any {
    return {
      config: {
        agentLoop: {
          enabled: true,
          every: '5m',
          maxConcurrent: 2,
          strategist: { enabled: false, everyCycles: 3, minInterval: '1h' },
        },
        bots: [{ id: 'bot1', name: 'Bot 1' }],
        karma: { enabled: true },
      },
      runningBots: new Set(['bot1']),
      logger: mockLogger(),
      getBotLogger: () => mockLogger(),
      getLLMClient: () => ({ backend: 'ollama' }),
      activityStream: { publish: mock(() => {}) },
    };
  }

  test('ask_human answer credits askAnswered under the engagement source', () => {
    const ctx = makeCtx();
    const karma = makeKarma();
    const scheduler = new AgentScheduler(ctx, mock());
    scheduler.setKarmaService(karma);
    scheduler.syncSchedules();

    scheduler.recordFeedbackEvent('bot1', 'ask_human');

    const events = karma.getAllEvents('bot1');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('askAnswered');
    expect(events[0].source).toBe('engagement');
    expect(events[0].delta).toBe(2);
    expect(ctx.activityStream.publish).toHaveBeenCalledTimes(1);
    expect(ctx.activityStream.publish.mock.calls[0][0].type).toBe('karma:change');
  });

  test('human_message credits humanReply once per cooldown window', () => {
    const karma = makeKarma();
    const scheduler = new AgentScheduler(makeCtx(), mock());
    scheduler.setKarmaService(karma);
    scheduler.syncSchedules();

    scheduler.recordFeedbackEvent('bot1', 'human_message');
    scheduler.recordFeedbackEvent('bot1', 'human_message');
    scheduler.recordFeedbackEvent('bot1', 'human_message');

    const events = karma.getAllEvents('bot1');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('humanReply');
    expect(events[0].delta).toBe(3);
    // The engagement-gate signal itself is still recorded every time
    expect(scheduler.getSchedule('bot1')?.feedbackEvents).toHaveLength(3);
  });

  test('agent_feedback records the signal but mints no karma; disabled karma config is a no-op', () => {
    const karma = makeKarma();
    const scheduler = new AgentScheduler(makeCtx(), mock());
    scheduler.setKarmaService(karma);
    scheduler.syncSchedules();
    scheduler.recordFeedbackEvent('bot1', 'agent_feedback');
    expect(karma.getAllEvents('bot1')).toHaveLength(0);

    const ctx = makeCtx();
    ctx.config.karma.enabled = false;
    const off = new AgentScheduler(ctx, mock());
    off.setKarmaService(karma);
    off.syncSchedules();
    off.recordFeedbackEvent('bot1', 'ask_human');
    expect(karma.getAllEvents('bot1')).toHaveLength(0);
  });

  test('without a karma service the scheduler keeps working', () => {
    const scheduler = new AgentScheduler(makeCtx(), mock());
    scheduler.syncSchedules();
    expect(() => scheduler.recordFeedbackEvent('bot1', 'ask_human')).not.toThrow();
  });
});

// ── Productions: approve / reject ──

describe('ProductionsService.evaluate → karma outcomes', () => {
  function makeService(): ProductionsService {
    const config: any = {
      bots: [
        {
          id: 'bot1',
          name: 'Bot One',
          token: '',
          enabled: true,
          skills: [],
          productions: { enabled: true, trackOnly: false },
        },
      ],
      productions: { enabled: true, baseDir: join(dataDir, 'productions') },
    };
    return new ProductionsService(config, mockLogger());
  }
  function log(service: ProductionsService, path: string) {
    return service.logProduction({
      timestamp: new Date().toISOString(),
      botId: 'bot1',
      tool: 'file_write',
      path,
      action: 'create',
      description: 'test',
      size: 10,
      trackOnly: false,
    });
  }

  test('approval credits productionApproved from the rewards table (not the rating)', () => {
    const service = makeService();
    const karma = makeKarma();
    const stream = { publish: mock(() => {}) } as any;
    const entry = log(service, 'report.md');

    service.evaluate('bot1', entry.id, { status: 'approved', rating: 5 }, undefined, karma, stream);

    const events = karma.getAllEvents('bot1');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('productionApproved');
    expect(events[0].delta).toBe(3);
    expect(events[0].source).toBe('production');
    expect(events[0].reason).toContain('report.md');
    expect(events[0].reason).toContain('5/5');
    expect(events[0].metadata?.rating).toBe(5);
    expect(stream.publish).toHaveBeenCalledTimes(1);
    expect(stream.publish.mock.calls[0][0].data.delta).toBe(3);
  });

  test('rejection debits productionRejected (-1 by default)', () => {
    const service = makeService();
    const karma = makeKarma();
    const entry = log(service, 'draft.md');

    service.evaluate('bot1', entry.id, { status: 'rejected' }, undefined, karma);

    const events = karma.getAllEvents('bot1');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('productionRejected');
    expect(events[0].delta).toBe(-1);
  });

  test('a kind configured to 0 publishes nothing to the activity stream', () => {
    const service = makeService();
    const karma = makeKarma({ rewards: { productionApproved: 0 } });
    const stream = { publish: mock(() => {}) } as any;
    const entry = log(service, 'x.md');

    const updated = service.evaluate(
      'bot1',
      entry.id,
      { status: 'approved' },
      undefined,
      karma,
      stream
    );

    expect(updated?.evaluation?.status).toBe('approved');
    expect(karma.getAllEvents('bot1')).toHaveLength(0);
    expect(stream.publish).not.toHaveBeenCalled();
  });
});

// ── Agent loop: novel action hook ──

describe('AgentLoop novel-action karma hook', () => {
  const contentPlan = JSON.stringify({
    reasoning: 'more docs',
    plan: ['Write and create docs/guide-6.md'],
    priority: 'medium',
  });

  function makeLoop(karma: KarmaService) {
    const soulLoader = {
      readIdentity: () => 'id',
      readSoul: () => 'soul',
      readMotivations: () => 'mot',
      readGoals: () => '',
      readRecentDailyLogs: () => '',
      readDailyLogsSince: () => '',
      appendDailyMemory: () => {},
      writeGoals: () => {},
    };
    const llm: any = {
      backend: 'ollama',
      generate: mock(() => Promise.resolve({ text: contentPlan })),
      chat: mock(() => Promise.resolve({ text: 'executed' })),
      getBackendClient: () => llm,
    };
    const botConfig = { id: 'bot1', name: 'Bot 1' };
    const ctx: any = {
      config: {
        agentLoop: GlobalAgentLoopConfigSchema.parse({ strategist: { enabled: false } }),
        conversation: { systemPrompt: '', temperature: 0.7, maxHistory: 10 },
        bots: [botConfig],
        paths: { data: dataDir },
        ollama: { models: { primary: 'm' } },
        claudeCli: { model: 'c' },
        karma: { enabled: true },
        productions: { baseDir: join(dataDir, 'productions') },
        soul: { dir: join(dataDir, 'soul') },
      },
      runningBots: new Set(['bot1']),
      logger: mockLogger(),
      tools: [],
      soulLoaders: new Map([['bot1', soulLoader]]),
      llmClients: new Map([['bot1', llm]]),
      agentFeedbackStore: { getPending: () => [] },
      askHumanStore: { consumeAnswersForBot: () => [], getPendingForBot: () => [] },
      askPermissionStore: {
        consumeDecisionsForBot: () => [],
        getPendingForBot: () => [],
        reportExecution: () => {},
      },
      llmQueryLog: { append: () => {} },
      sessionManager: { listSessions: () => [] },
      getLLMClient: () => llm,
      getActiveModel: () => 'm',
      getBotLogger: () => mockLogger(),
      getSoulLoader: () => soulLoader,
      resolveBotId: (id: string) => id,
      activityStream: { publish: mock(() => {}) },
    };
    const loop = new AgentLoop(
      ctx,
      { build: () => 'system' } as any,
      { getDefinitionsForBot: () => [], getDefinitionsByCategories: () => [] } as any
    );
    loop.setKarmaService(karma);
    (loop as any).scheduler.syncSchedules();
    return { loop, ctx };
  }

  test('a non-idle cycle writes no "Novel action" entry with default rewards', async () => {
    const karma = makeKarma();
    const { loop, ctx } = makeLoop(karma);
    const result = await loop.runOne('bot1');
    expect(result.status).toBe('completed');
    expect(karma.getAllEvents('bot1').filter((e) => e.reason.startsWith('Novel action'))).toEqual(
      []
    );
    const karmaPublishes = ctx.activityStream.publish.mock.calls.filter(
      (c: any[]) => c[0].type === 'karma:change'
    );
    expect(karmaPublishes).toHaveLength(0);
  });

  test('rewards.novelAction > 0 restores the legacy activity credit', async () => {
    const karma = makeKarma({ rewards: { novelAction: 1 } });
    const { loop } = makeLoop(karma);
    await loop.runOne('bot1');
    const novel = karma.getAllEvents('bot1').filter((e) => e.kind === 'novelAction');
    expect(novel).toHaveLength(1);
    expect(novel[0].delta).toBe(1);
    expect(novel[0].source).toBe('agent-loop');
  });
});

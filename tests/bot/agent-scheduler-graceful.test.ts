import { beforeEach, describe, expect, test, vi } from 'bun:test';
import type { AgentLoopResult } from '../../src/bot/agent-loop';
import { AgentScheduler } from '../../src/bot/agent-scheduler';

function makeMockCtx(overrides: Record<string, unknown> = {}): any {
  return {
    config: {
      agentLoop: {
        enabled: true,
        every: '5m',
        maxConcurrent: 2,
        strategist: { enabled: false, everyCycles: 3, minInterval: '1h' },
      },
      bots: [
        { id: 'bot1', name: 'Bot 1' },
        { id: 'bot2', name: 'Bot 2' },
      ],
    },
    runningBots: new Set(['bot1', 'bot2']),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getBotLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    ...overrides,
  };
}

function makeResult(partial: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    botId: 'bot1',
    botName: 'Bot 1',
    status: 'completed',
    summary: 'done',
    durationMs: 100,
    plannerReasoning: '',
    plan: [],
    toolCalls: [],
    strategistRan: false,
    ...partial,
  };
}

describe('AgentScheduler — graceful stop', () => {
  let ctx: ReturnType<typeof makeMockCtx>;
  let runOneBotFn: ReturnType<typeof vi.fn>;
  let scheduler: AgentScheduler;

  beforeEach(() => {
    ctx = makeMockCtx();
    runOneBotFn = vi.fn().mockResolvedValue(makeResult());
    scheduler = new AgentScheduler(ctx, runOneBotFn);
  });

  test('isDraining returns false initially', () => {
    expect(scheduler.isDraining()).toBe(false);
  });

  test('gracefulStop sets draining, then resets after completion', async () => {
    scheduler.start();
    expect(scheduler.isDraining()).toBe(false);

    await scheduler.gracefulStop(2000);

    // After graceful stop, draining is reset and scheduler is stopped
    expect(scheduler.isDraining()).toBe(false);
    expect(scheduler.isEnabled()).toBe(false);
  });

  test('gracefulStop is idempotent — calling twice does not throw', async () => {
    // First graceful stop (no loops active, resolves immediately)
    await scheduler.gracefulStop(2000);
    expect(scheduler.isDraining()).toBe(false);

    // Second call after first completed — should also resolve cleanly
    await scheduler.gracefulStop(2000);
    expect(scheduler.isDraining()).toBe(false);
  });

  test('gracefulStop resolves immediately when no loops are active', async () => {
    // Don't start the scheduler — no loops running
    const start = Date.now();
    await scheduler.gracefulStop(5000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  test('gracefulStop wakes sleeping bots', async () => {
    const sleepPromise = scheduler.interruptibleSleep(60_000);
    expect(scheduler.isSleeping()).toBe(true);

    await scheduler.gracefulStop(2000);

    // Sleep should have been interrupted
    await sleepPromise;
    expect(scheduler.isSleeping()).toBe(false);
  });
});

describe('AgentScheduler — isExecutingLoop', () => {
  let ctx: ReturnType<typeof makeMockCtx>;
  let runOneBotFn: ReturnType<typeof vi.fn>;
  let scheduler: AgentScheduler;

  beforeEach(() => {
    ctx = makeMockCtx();
    runOneBotFn = vi.fn().mockResolvedValue(makeResult());
    scheduler = new AgentScheduler(ctx, runOneBotFn);
  });

  test('isExecutingLoop returns false for unknown bot', () => {
    expect(scheduler.isExecutingLoop('nonexistent')).toBe(false);
  });

  test('isExecutingLoop returns false when bot is not executing', () => {
    scheduler.syncSchedules();
    expect(scheduler.isExecutingLoop('bot1')).toBe(false);
  });

  test('buildScheduleInfos includes isExecutingLoop field', () => {
    scheduler.syncSchedules();
    const infos = scheduler.buildScheduleInfos();
    expect(infos).toHaveLength(2);

    for (const info of infos) {
      expect(info).toHaveProperty('isExecutingLoop');
      expect(info.isExecutingLoop).toBe(false);
    }
  });
});

import { beforeEach, describe, expect, test, vi } from 'bun:test';
import type { AgentLoopResult } from '../../src/bot/agent-loop';
import { AgentScheduler } from '../../src/bot/agent-scheduler';

// ---------------------------------------------------------------------------
// Helpers (same pattern as agent-scheduler.test.ts)
// ---------------------------------------------------------------------------

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
    summary: 'did stuff',
    durationMs: 1000,
    plannerReasoning: 'because',
    plan: ['step1'],
    toolCalls: [],
    strategistRan: false,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentScheduler — immediate run', () => {
  let ctx: ReturnType<typeof makeMockCtx>;
  let runOneBotFn: ReturnType<typeof vi.fn>;
  let scheduler: AgentScheduler;

  beforeEach(() => {
    ctx = makeMockCtx();
    runOneBotFn = vi.fn().mockResolvedValue(makeResult());
    scheduler = new AgentScheduler(ctx, runOneBotFn);
  });

  // -----------------------------------------------------------------------
  // requestImmediateRun — no-op cases
  // -----------------------------------------------------------------------

  describe('requestImmediateRun — no-op cases', () => {
    test('no-ops when scheduler is not enabled', () => {
      // scheduler.start() not called, so enabled = false
      scheduler.syncSchedules();
      scheduler.requestImmediateRun('bot1');
      // No wake or pending should happen
      expect(ctx.logger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ botId: 'bot1' }),
        expect.stringContaining('immediate run')
      );
    });

    test('no-ops when bot is not in runningBots', () => {
      scheduler.start();
      scheduler.syncSchedules();
      scheduler.requestImmediateRun('nonexistent');
      expect(ctx.logger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ botId: 'nonexistent' }),
        expect.stringContaining('immediate run')
      );
      scheduler.stop();
    });
  });

  // -----------------------------------------------------------------------
  // requestImmediateRun — bot idle (sets nextRunAt + wakes)
  // -----------------------------------------------------------------------

  describe('requestImmediateRun — bot idle', () => {
    test('sets nextRunAt to now and wakes when bot is idle', () => {
      // Manually enable without starting the internal loop (start() kicks off
      // async bot loops that would race with the test)
      (scheduler as any).enabled = true;
      scheduler.syncSchedules();

      const schedule = scheduler.getSchedule('bot1')!;
      const futureTime = Date.now() + 300_000;
      schedule.nextRunAt = futureTime;

      const before = Date.now();
      scheduler.requestImmediateRun('bot1');

      expect(schedule.nextRunAt).toBeGreaterThanOrEqual(before);
      expect(schedule.nextRunAt).toBeLessThanOrEqual(Date.now());
      expect(schedule.nextRunAt).toBeLessThan(futureTime);

      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ botId: 'bot1' }),
        expect.stringContaining('immediate run triggered')
      );
    });

    test('calls wakeUp to abort current sleep', async () => {
      (scheduler as any).enabled = true;
      scheduler.syncSchedules();

      const sleepPromise = scheduler.interruptibleSleep(60_000);
      expect(scheduler.isSleeping()).toBe(true);

      scheduler.requestImmediateRun('bot1');

      // Sleep should resolve quickly because wakeUp was called
      await sleepPromise;
      expect(scheduler.isSleeping()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // requestImmediateRun — bot busy (queues pending wake)
  // -----------------------------------------------------------------------

  describe('requestImmediateRun — bot busy', () => {
    test('queues pending wake when bot is currently executing', () => {
      (scheduler as any).enabled = true;
      scheduler.syncSchedules();

      // Simulate bot being busy
      scheduler.getRunningBotIds().add('bot1');

      scheduler.requestImmediateRun('bot1');

      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ botId: 'bot1' }),
        expect.stringContaining('queued pending wake')
      );
    });

    test('does not modify nextRunAt when bot is busy', () => {
      (scheduler as any).enabled = true;
      scheduler.syncSchedules();

      const schedule = scheduler.getSchedule('bot1')!;
      const originalNextRunAt = schedule.nextRunAt;

      scheduler.getRunningBotIds().add('bot1');
      scheduler.requestImmediateRun('bot1');

      expect(schedule.nextRunAt).toBe(originalNextRunAt);
    });
  });

  // -----------------------------------------------------------------------
  // consumePendingWake
  // -----------------------------------------------------------------------

  describe('consumePendingWake', () => {
    test('returns true and removes when a pending wake exists', () => {
      (scheduler as any).enabled = true;
      scheduler.syncSchedules();
      scheduler.getRunningBotIds().add('bot1');

      scheduler.requestImmediateRun('bot1');
      expect(scheduler.consumePendingWake('bot1')).toBe(true);
      // Second call should return false (already consumed)
      expect(scheduler.consumePendingWake('bot1')).toBe(false);
    });

    test('returns false when no pending wake exists', () => {
      expect(scheduler.consumePendingWake('bot1')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Set deduplication
  // -----------------------------------------------------------------------

  describe('pending wake deduplication', () => {
    test('multiple requests for same bot coalesce into one', () => {
      (scheduler as any).enabled = true;
      scheduler.syncSchedules();
      scheduler.getRunningBotIds().add('bot1');

      scheduler.requestImmediateRun('bot1');
      scheduler.requestImmediateRun('bot1');
      scheduler.requestImmediateRun('bot1');

      // Only one consume should succeed
      expect(scheduler.consumePendingWake('bot1')).toBe(true);
      expect(scheduler.consumePendingWake('bot1')).toBe(false);
    });

    test('different bots can have independent pending wakes', () => {
      (scheduler as any).enabled = true;
      scheduler.syncSchedules();
      scheduler.getRunningBotIds().add('bot1');
      scheduler.getRunningBotIds().add('bot2');

      scheduler.requestImmediateRun('bot1');
      scheduler.requestImmediateRun('bot2');

      expect(scheduler.consumePendingWake('bot1')).toBe(true);
      expect(scheduler.consumePendingWake('bot2')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // stop() clears pending wakes
  // -----------------------------------------------------------------------

  describe('stop clears pending wakes', () => {
    test('pending wakes are cleared on stop', () => {
      (scheduler as any).enabled = true;
      scheduler.syncSchedules();
      scheduler.getRunningBotIds().add('bot1');

      scheduler.requestImmediateRun('bot1');
      scheduler.stop();

      // After stop, pending wake should be gone
      expect(scheduler.consumePendingWake('bot1')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Integration: runBotLoop skips sleep on pending wake
  // -----------------------------------------------------------------------

  describe('runBotLoop integration — pending wake skips sleep', () => {
    test('bot executes again immediately when pending wake is consumed', async () => {
      let callCount = 0;
      // testScheduler is assigned below before start() — the closure captures the variable
      let testScheduler: AgentScheduler;

      const slowRunFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // During first execution, simulate a pending wake request
          testScheduler.requestImmediateRun('bot1');
        }
        return makeResult();
      });

      const singleBotCtx = makeMockCtx({
        config: {
          agentLoop: {
            enabled: true,
            every: '60s', // long sleep so we can test the skip
            maxConcurrent: 2,
            strategist: { enabled: false, everyCycles: 3, minInterval: '1h' },
          },
          bots: [{ id: 'bot1', name: 'Bot 1' }],
        },
        runningBots: new Set(['bot1']),
      });

      testScheduler = new AgentScheduler(singleBotCtx, slowRunFn);
      testScheduler.start();

      // Wait enough for 2 executions (first run + immediate re-run after pending wake)
      // but not long enough for a full 60s sleep cycle
      await new Promise((r) => setTimeout(r, 3000));

      testScheduler.stop();

      // Should have run at least 2 times: first execution + immediate re-run
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });
});

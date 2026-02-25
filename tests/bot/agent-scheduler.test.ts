import { describe, test, expect, beforeEach, vi } from 'bun:test';
import { AgentScheduler, type BotSchedule } from '../../src/bot/agent-scheduler';
import type { AgentLoopResult } from '../../src/bot/agent-loop';

// ---------------------------------------------------------------------------
// Note: We don't mock agent-strategist here because:
// 1. Bun's vi.mock persists across test files and lacks vi.unmock()
// 2. The real implementation is simple enough to use directly
// 3. This avoids polluting other tests that import the real module
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
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
        { id: 'bot2', name: 'Bot 2', agentLoop: { mode: 'continuous' } },
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

describe('AgentScheduler', () => {
  let ctx: ReturnType<typeof makeMockCtx>;
  let runOneBotFn: ReturnType<typeof vi.fn>;
  let scheduler: AgentScheduler;

  beforeEach(() => {
    ctx = makeMockCtx();
    runOneBotFn = vi.fn().mockResolvedValue(makeResult());
    scheduler = new AgentScheduler(ctx, runOneBotFn);
  });

  // -----------------------------------------------------------------------
  // 1. syncSchedules — adding / removing bots
  // -----------------------------------------------------------------------

  describe('syncSchedules', () => {
    test('adds schedules for running bots that are not yet scheduled', () => {
      scheduler.syncSchedules();
      const schedules = scheduler.getSchedules();
      expect(schedules.size).toBe(2);
      expect(schedules.has('bot1')).toBe(true);
      expect(schedules.has('bot2')).toBe(true);
    });

    test('new schedule has sensible defaults', () => {
      scheduler.syncSchedules();
      const s = scheduler.getSchedule('bot1')!;
      expect(s.lastRunAt).toBeNull();
      expect(s.lastResult).toBeNull();
      expect(s.nextCheckIn).toBeNull();
      expect(s.strategistCycleCount).toBe(0);
      expect(s.lastStrategistAt).toBeNull();
      expect(s.lastFocus).toBeNull();
      expect(s.continuousCycleCount).toBe(0);
      expect(s.sessionStartAt).toBeNull();
      expect(s.recentActions).toEqual([]);
      expect(s.consecutiveIdleCycles).toBe(0);
      expect(s.lastLoggedSummary).toBeNull();
      expect(s.retryCount).toBe(0);
      expect(s.lastErrorMessage).toBeNull();
    });

    test('stagger offsets are applied in order', () => {
      scheduler.syncSchedules();
      const s1 = scheduler.getSchedule('bot1')!;
      const s2 = scheduler.getSchedule('bot2')!;
      // bot1 added first (stagger 0), bot2 added second (stagger 30000)
      expect(s2.nextRunAt - s1.nextRunAt).toBe(30_000);
    });

    test('does not overwrite existing schedules on re-sync', () => {
      scheduler.syncSchedules();
      const before = scheduler.getSchedule('bot1')!;
      before.lastFocus = 'focused';
      scheduler.syncSchedules();
      expect(scheduler.getSchedule('bot1')!.lastFocus).toBe('focused');
    });

    test('removes schedules for bots no longer in runningBots', () => {
      scheduler.syncSchedules();
      expect(scheduler.getSchedules().size).toBe(2);

      ctx.runningBots.delete('bot2');
      scheduler.syncSchedules();
      expect(scheduler.getSchedules().size).toBe(1);
      expect(scheduler.getSchedule('bot2')).toBeUndefined();
    });

    test('logs when adding and removing bots', () => {
      scheduler.syncSchedules();
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ botId: 'bot1' }),
        expect.stringContaining('added new bot'),
      );

      ctx.runningBots.delete('bot2');
      scheduler.syncSchedules();
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ botId: 'bot2' }),
        expect.stringContaining('removed stopped bot'),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 2. Bot mode detection
  // -----------------------------------------------------------------------

  describe('getBotMode / isContinuousBot', () => {
    test('returns periodic for bots without agentLoop.mode override', () => {
      expect(scheduler.getBotMode('bot1')).toBe('periodic');
      expect(scheduler.isContinuousBot('bot1')).toBe(false);
    });

    test('returns continuous for bots with agentLoop.mode = continuous', () => {
      expect(scheduler.getBotMode('bot2')).toBe('continuous');
      expect(scheduler.isContinuousBot('bot2')).toBe(true);
    });

    test('returns periodic for unknown bot IDs', () => {
      expect(scheduler.getBotMode('nonexistent')).toBe('periodic');
      expect(scheduler.isContinuousBot('nonexistent')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 3. interruptibleSleep and abort
  // -----------------------------------------------------------------------

  describe('interruptibleSleep', () => {
    test('resolves after the given timeout', async () => {
      const start = Date.now();
      await scheduler.interruptibleSleep(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });

    test('isSleeping returns true during sleep, false after', async () => {
      expect(scheduler.isSleeping()).toBe(false);
      const promise = scheduler.interruptibleSleep(200);
      expect(scheduler.isSleeping()).toBe(true);
      scheduler.wakeUp();
      await promise;
      expect(scheduler.isSleeping()).toBe(false);
    });

    test('wakeUp aborts all ongoing sleeps', async () => {
      const start = Date.now();
      const p1 = scheduler.interruptibleSleep(10_000);
      const p2 = scheduler.interruptibleSleep(10_000);
      scheduler.wakeUp();
      await Promise.all([p1, p2]);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
    });

    test('sleepControllers are cleaned up after resolve', async () => {
      const p = scheduler.interruptibleSleep(10);
      expect(scheduler.isSleeping()).toBe(true);
      await p;
      expect(scheduler.isSleeping()).toBe(false);
    });

    test('multiple interruptibleSleep calls tracked independently', async () => {
      const p1 = scheduler.interruptibleSleep(10_000);
      const p2 = scheduler.interruptibleSleep(20);
      // p2 should resolve on its own
      await p2;
      // p1 is still sleeping
      expect(scheduler.isSleeping()).toBe(true);
      scheduler.wakeUp();
      await p1;
      expect(scheduler.isSleeping()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Concurrency acquire / release / queuing
  // -----------------------------------------------------------------------

  describe('concurrency', () => {
    test('acquireConcurrency allows up to maxConcurrent slots', async () => {
      await scheduler.acquireConcurrency();
      await scheduler.acquireConcurrency();
      // Both acquired — should not hang
    });

    test('acquireConcurrency queues when limit is reached', async () => {
      await scheduler.acquireConcurrency(); // slot 1
      await scheduler.acquireConcurrency(); // slot 2 (maxConcurrent=2)

      let thirdAcquired = false;
      const p3 = scheduler.acquireConcurrency().then(() => {
        thirdAcquired = true;
      });

      // Give time for any promise to resolve
      await new Promise((r) => setTimeout(r, 30));
      expect(thirdAcquired).toBe(false);

      scheduler.releaseConcurrency();
      await p3;
      expect(thirdAcquired).toBe(true);
    });

    test('releaseConcurrency dequeues in FIFO order', async () => {
      await scheduler.acquireConcurrency();
      await scheduler.acquireConcurrency();

      const order: number[] = [];
      const p1 = scheduler.acquireConcurrency().then(() => order.push(1));
      const p2 = scheduler.acquireConcurrency().then(() => order.push(2));

      scheduler.releaseConcurrency();
      await p1;
      scheduler.releaseConcurrency();
      await p2;

      expect(order).toEqual([1, 2]);
    });

    test('release without acquire does not crash', () => {
      // Just verifying it doesn't throw
      scheduler.releaseConcurrency();
    });
  });

  // -----------------------------------------------------------------------
  // 5. updateBotSchedule
  // -----------------------------------------------------------------------

  describe('updateBotSchedule', () => {
    const bot1Config = { id: 'bot1', name: 'Bot 1' } as any;
    const bot2Config = { id: 'bot2', name: 'Bot 2', agentLoop: { mode: 'continuous' } } as any;

    test('updates an existing schedule entry', () => {
      scheduler.syncSchedules();
      const result = makeResult({ botId: 'bot1', status: 'completed', strategistRan: false });
      scheduler.updateBotSchedule('bot1', bot1Config, result);

      const s = scheduler.getSchedule('bot1')!;
      expect(s.lastRunAt).toBeGreaterThan(0);
      expect(s.lastResult).toBe(result);
      expect(s.nextCheckIn).toBe('5m');
      expect(s.strategistCycleCount).toBe(1); // incremented from 0
    });

    test('creates a new schedule entry if not synced yet', () => {
      const result = makeResult({ botId: 'bot1', status: 'completed' });
      scheduler.updateBotSchedule('bot1', bot1Config, result);

      const s = scheduler.getSchedule('bot1')!;
      expect(s.lastRunAt).toBeGreaterThan(0);
      expect(s.lastResult).toBe(result);
    });

    test('resets strategistCycleCount when strategistRan is true', () => {
      scheduler.syncSchedules();
      // Run 2 cycles without strategist
      scheduler.updateBotSchedule('bot1', bot1Config, makeResult({ strategistRan: false }));
      scheduler.updateBotSchedule('bot1', bot1Config, makeResult({ strategistRan: false }));
      expect(scheduler.getSchedule('bot1')!.strategistCycleCount).toBe(2);

      // Run with strategist
      scheduler.updateBotSchedule('bot1', bot1Config, makeResult({ strategistRan: true, focus: 'new focus' }));
      const s = scheduler.getSchedule('bot1')!;
      expect(s.strategistCycleCount).toBe(0);
      expect(s.lastStrategistAt).toBeGreaterThan(0);
      expect(s.lastFocus).toBe('new focus');
    });

    test('continuous bot gets sleepMs of 0', () => {
      scheduler.syncSchedules();
      const result = makeResult({ botId: 'bot2', botName: 'Bot 2', status: 'completed' });
      const before = Date.now();
      scheduler.updateBotSchedule('bot2', bot2Config, result);
      const s = scheduler.getSchedule('bot2')!;
      // nextRunAt should be ~now (sleepMs=0)
      expect(s.nextRunAt).toBeGreaterThanOrEqual(before);
      expect(s.nextRunAt).toBeLessThanOrEqual(before + 100);
    });

    test('continuous bot increments continuousCycleCount', () => {
      scheduler.syncSchedules();
      scheduler.updateBotSchedule('bot2', bot2Config, makeResult({ botId: 'bot2' }));
      scheduler.updateBotSchedule('bot2', bot2Config, makeResult({ botId: 'bot2' }));
      expect(scheduler.getSchedule('bot2')!.continuousCycleCount).toBe(2);
    });

    test('clears retryCount and lastErrorMessage on non-error result', () => {
      scheduler.syncSchedules();
      // Simulate error state
      const s = scheduler.getSchedule('bot1')!;
      s.retryCount = 3;
      s.lastErrorMessage = 'boom';

      scheduler.updateBotSchedule('bot1', bot1Config, makeResult({ status: 'completed' }));
      expect(scheduler.getSchedule('bot1')!.retryCount).toBe(0);
      expect(scheduler.getSchedule('bot1')!.lastErrorMessage).toBeNull();
    });

    test('preserves retryCount on error result', () => {
      scheduler.syncSchedules();
      const s = scheduler.getSchedule('bot1')!;
      s.retryCount = 2;
      s.lastErrorMessage = 'old error';

      // Error result — retryCount/lastErrorMessage not cleared by updateBotSchedule
      scheduler.updateBotSchedule('bot1', bot1Config, makeResult({ status: 'error' }));
      expect(scheduler.getSchedule('bot1')!.retryCount).toBe(2);
      expect(scheduler.getSchedule('bot1')!.lastErrorMessage).toBe('old error');
    });

    test('uses bot-specific every when configured', () => {
      const botWithEvery = { id: 'bot1', name: 'Bot 1', agentLoop: { every: '10m' } } as any;
      ctx.config.bots = [botWithEvery];
      scheduler.syncSchedules();

      scheduler.updateBotSchedule('bot1', botWithEvery, makeResult());
      expect(scheduler.getSchedule('bot1')!.nextCheckIn).toBe('10m');
    });
  });

  // -----------------------------------------------------------------------
  // 6. computeBotSleepMs
  // -----------------------------------------------------------------------

  describe('computeBotSleepMs', () => {
    test('returns parsed global every for completed result', () => {
      const ms = scheduler.computeBotSleepMs('bot1', makeResult({ status: 'completed' }));
      // '5m' = 300_000
      expect(ms).toBe(300_000);
    });

    test('returns parsed global every for skipped result', () => {
      const ms = scheduler.computeBotSleepMs('bot1', makeResult({ status: 'skipped' }));
      expect(ms).toBe(300_000);
    });

    test('returns at least 5 minutes on error', () => {
      const ms = scheduler.computeBotSleepMs('bot1', makeResult({ status: 'error' }));
      expect(ms).toBe(300_000); // max(300_000, 300_000) = 300_000
    });

    test('returns at least 5 minutes on error even if every is shorter', () => {
      // Set global every to 1m (60_000) — error floor is 5m
      ctx.config.agentLoop.every = '1m';
      const ms = scheduler.computeBotSleepMs('bot1', makeResult({ status: 'error' }));
      expect(ms).toBe(300_000);
    });

    test('uses bot-specific every when configured', () => {
      ctx.config.bots = [{ id: 'bot1', name: 'Bot 1', agentLoop: { every: '10m' } }];
      const ms = scheduler.computeBotSleepMs('bot1', makeResult({ status: 'completed' }));
      expect(ms).toBe(600_000); // 10m = 600_000
    });

    test('bot-specific every with error is floored at 5m', () => {
      ctx.config.bots = [{ id: 'bot1', name: 'Bot 1', agentLoop: { every: '2m' } }];
      const ms = scheduler.computeBotSleepMs('bot1', makeResult({ status: 'error' }));
      expect(ms).toBe(300_000); // max(120_000, 300_000)
    });

    test('bot-specific every longer than 5m is respected on error', () => {
      ctx.config.bots = [{ id: 'bot1', name: 'Bot 1', agentLoop: { every: '10m' } }];
      const ms = scheduler.computeBotSleepMs('bot1', makeResult({ status: 'error' }));
      expect(ms).toBe(600_000); // max(600_000, 300_000)
    });
  });

  // -----------------------------------------------------------------------
  // 7. buildScheduleInfos
  // -----------------------------------------------------------------------

  describe('buildScheduleInfos', () => {
    test('returns empty array when no schedules exist', () => {
      expect(scheduler.buildScheduleInfos()).toEqual([]);
    });

    test('builds infos for all scheduled bots', () => {
      scheduler.syncSchedules();
      const infos = scheduler.buildScheduleInfos();
      expect(infos).toHaveLength(2);

      const bot1Info = infos.find((i) => i.botId === 'bot1')!;
      expect(bot1Info.botName).toBe('Bot 1');
      expect(bot1Info.mode).toBe('periodic');
      expect(bot1Info.nextRunAt).toBeGreaterThan(0);
      expect(bot1Info.lastRunAt).toBeNull();
      expect(bot1Info.lastStatus).toBeNull();

      const bot2Info = infos.find((i) => i.botId === 'bot2')!;
      expect(bot2Info.botName).toBe('Bot 2');
      expect(bot2Info.mode).toBe('continuous');
      expect(bot2Info.nextRunAt).toBeNull(); // continuous mode
    });

    test('reflects last status after an update', () => {
      scheduler.syncSchedules();
      const result = makeResult({ botId: 'bot1', status: 'completed', focus: 'write poem' });
      scheduler.updateBotSchedule('bot1', ctx.config.bots[0] as any, result);

      const infos = scheduler.buildScheduleInfos();
      const bot1Info = infos.find((i) => i.botId === 'bot1')!;
      expect(bot1Info.lastStatus).toBe('completed');
      expect(bot1Info.lastRunAt).toBeGreaterThan(0);
    });

    test('includes strategistCyclesUntilNext', () => {
      scheduler.syncSchedules();
      const infos = scheduler.buildScheduleInfos();
      // Mock returns max(0, 3 - strategistCycleCount) => 3 - 0 = 3
      expect(infos[0].strategistCyclesUntilNext).toBe(3);
    });

    test('includes recentActionsSummary (last 5)', () => {
      scheduler.syncSchedules();
      const s = scheduler.getSchedule('bot1')!;
      for (let i = 0; i < 7; i++) {
        s.recentActions.push({ cycle: i, timestamp: Date.now(), tools: [], planSummary: `action-${i}` });
      }
      const infos = scheduler.buildScheduleInfos();
      const bot1Info = infos.find((i) => i.botId === 'bot1')!;
      expect(bot1Info.recentActionsSummary).toHaveLength(5);
      expect(bot1Info.recentActionsSummary[0]).toBe('action-2');
      expect(bot1Info.recentActionsSummary[4]).toBe('action-6');
    });

    test('uses botId as fallback name for unknown bots', () => {
      // Manually insert a schedule for a bot not in config
      ctx.runningBots.add('ghost');
      scheduler.syncSchedules();
      const infos = scheduler.buildScheduleInfos();
      const ghostInfo = infos.find((i) => i.botId === 'ghost')!;
      expect(ghostInfo.botName).toBe('ghost');
    });

    test('includes idle and error info', () => {
      scheduler.syncSchedules();
      const s = scheduler.getSchedule('bot1')!;
      s.consecutiveIdleCycles = 3;
      s.retryCount = 2;
      s.lastErrorMessage = 'timeout';

      const infos = scheduler.buildScheduleInfos();
      const bot1Info = infos.find((i) => i.botId === 'bot1')!;
      expect(bot1Info.isIdle).toBe(true);
      expect(bot1Info.consecutiveIdleCycles).toBe(3);
      expect(bot1Info.retryCount).toBe(2);
      expect(bot1Info.lastErrorMessage).toBe('timeout');
    });
  });

  // -----------------------------------------------------------------------
  // 8. getEarliestRunAt
  // -----------------------------------------------------------------------

  describe('getEarliestRunAt', () => {
    test('returns null when no schedules exist', () => {
      expect(scheduler.getEarliestRunAt()).toBeNull();
    });

    test('returns null when only continuous bots exist', () => {
      ctx.config.bots = [{ id: 'bot2', name: 'Bot 2', agentLoop: { mode: 'continuous' } }];
      ctx.runningBots = new Set(['bot2']);
      scheduler = new AgentScheduler(ctx, runOneBotFn);
      scheduler.syncSchedules();

      expect(scheduler.getEarliestRunAt()).toBeNull();
    });

    test('returns the earliest nextRunAt among periodic bots', () => {
      scheduler.syncSchedules();
      const s1 = scheduler.getSchedule('bot1')!;
      // bot2 is continuous, so only bot1 matters
      const earliest = scheduler.getEarliestRunAt();
      expect(earliest).toBe(s1.nextRunAt);
    });

    test('picks the smallest nextRunAt among multiple periodic bots', () => {
      ctx.config.bots = [
        { id: 'bot1', name: 'Bot 1' },
        { id: 'bot3', name: 'Bot 3' },
      ];
      ctx.runningBots = new Set(['bot1', 'bot3']);
      scheduler = new AgentScheduler(ctx, runOneBotFn);
      scheduler.syncSchedules();

      // bot1 has stagger 0, bot3 has stagger 30_000
      const s1 = scheduler.getSchedule('bot1')!;
      const s3 = scheduler.getSchedule('bot3')!;
      expect(s1.nextRunAt).toBeLessThan(s3.nextRunAt);
      expect(scheduler.getEarliestRunAt()).toBe(s1.nextRunAt);
    });
  });

  // -----------------------------------------------------------------------
  // 9. isSleeping
  // -----------------------------------------------------------------------

  describe('isSleeping', () => {
    test('returns false initially', () => {
      expect(scheduler.isSleeping()).toBe(false);
    });

    test('returns true when a sleep is in progress', async () => {
      const p = scheduler.interruptibleSleep(10_000);
      expect(scheduler.isSleeping()).toBe(true);
      scheduler.wakeUp();
      await p;
    });

    test('returns false after all sleeps complete', async () => {
      const p1 = scheduler.interruptibleSleep(10);
      const p2 = scheduler.interruptibleSleep(15);
      await Promise.all([p1, p2]);
      expect(scheduler.isSleeping()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle: start / stop / wakeUp
  // -----------------------------------------------------------------------

  describe('lifecycle', () => {
    test('start sets enabled=true and logs', () => {
      // We need to stop it quickly to avoid runaway loop
      scheduler.start();
      expect(scheduler.isEnabled()).toBe(true);
      scheduler.stop();
    });

    test('start does nothing when agentLoop.enabled=false', () => {
      ctx.config.agentLoop.enabled = false;
      scheduler = new AgentScheduler(ctx, runOneBotFn);
      scheduler.start();
      expect(scheduler.isEnabled()).toBe(false);
      expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    });

    test('start is idempotent', () => {
      scheduler.start();
      scheduler.start(); // second call should be a no-op
      expect(scheduler.isEnabled()).toBe(true);
      scheduler.stop();
    });

    test('stop clears schedules and disables', () => {
      scheduler.syncSchedules();
      expect(scheduler.getSchedules().size).toBe(2);
      scheduler.start();
      scheduler.stop();
      expect(scheduler.isEnabled()).toBe(false);
      expect(scheduler.getSchedules().size).toBe(0);
    });

    test('stop aborts in-flight sleeps', async () => {
      const p = scheduler.interruptibleSleep(10_000);
      scheduler.stop();
      // Sleep should resolve quickly because abort was called
      await p;
      expect(scheduler.isSleeping()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Getter coverage
  // -----------------------------------------------------------------------

  describe('getters', () => {
    test('getRunningBotIds returns the internal set', () => {
      expect(scheduler.getRunningBotIds().size).toBe(0);
    });

    test('getLastResults returns empty initially', () => {
      expect(scheduler.getLastResults()).toEqual([]);
    });

    test('getLastRunAt returns null initially', () => {
      expect(scheduler.getLastRunAt()).toBeNull();
    });

    test('isEnabled returns false initially', () => {
      expect(scheduler.isEnabled()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // syncBotLoops
  // -----------------------------------------------------------------------

  describe('syncBotLoops', () => {
    test('creates loops for running bots with configs', () => {
      // We just verify it doesn't throw. The actual loop is async and
      // tested through lifecycle / integration below.
      scheduler.start();
      // syncBotLoops is called internally by runLoop
      // Let's manually call it as well
      scheduler.syncBotLoops();
      scheduler.stop();
    });

    test('does not create loop for bot without config', () => {
      ctx.runningBots.add('noconfig');
      scheduler.syncBotLoops();
      // no crash — noconfig has no entry in config.bots
      scheduler.stop();
    });
  });
});

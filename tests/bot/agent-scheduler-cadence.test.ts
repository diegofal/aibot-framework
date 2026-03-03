import { beforeEach, describe, expect, test, vi } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLoopResult } from '../../src/bot/agent-loop';
import { AgentScheduler, type BotSchedule } from '../../src/bot/agent-scheduler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockCtx(overrides: Record<string, unknown> = {}): any {
  return {
    config: {
      agentLoop: {
        enabled: true,
        every: '6h',
        maxConcurrent: 2,
        strategist: { enabled: false, everyCycles: 3, minInterval: '1h' },
      },
      bots: [
        { id: 'bot1', name: 'Bot 1' },
        { id: 'bot2', name: 'Bot 2', agentLoop: { every: '2h' } },
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
// Fix 1: runBotLoop guard — early wakeUp does not cause out-of-schedule runs
// ---------------------------------------------------------------------------

describe('AgentScheduler — cadence guard (Fix 1)', () => {
  let ctx: ReturnType<typeof makeMockCtx>;
  let runOneBotFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ctx = makeMockCtx();
    runOneBotFn = vi.fn().mockResolvedValue(makeResult());
  });

  test('bot woken early by global wakeUp resumes sleep instead of running', async () => {
    // Configure bot1 with a long cadence (6h) and bot-target with immediate run
    const singleCtx = makeMockCtx({
      config: {
        agentLoop: {
          enabled: true,
          every: '60s', // Long enough that the bot shouldn't run twice in the test window
          maxConcurrent: 2,
          strategist: { enabled: false, everyCycles: 3, minInterval: '1h' },
        },
        bots: [{ id: 'bot1', name: 'Bot 1' }],
      },
      runningBots: new Set(['bot1']),
    });

    let callCount = 0;
    const trackingRunFn = vi.fn().mockImplementation(async () => {
      callCount++;
      return makeResult();
    });

    const scheduler = new AgentScheduler(singleCtx, trackingRunFn);
    scheduler.start();

    // Wait for the first execution
    await new Promise((r) => setTimeout(r, 500));
    expect(callCount).toBe(1);

    // Now call global wakeUp() — this simulates what happens when an operator
    // interacts with a different bot from the dashboard
    scheduler.wakeUp();

    // Wait a bit — the bot should NOT run again because its nextRunAt is ~60s in the future
    await new Promise((r) => setTimeout(r, 1500));
    expect(callCount).toBe(1); // Still 1 — the guard prevented the extra run

    scheduler.stop();
  });

  test('requestImmediateRun for a specific bot still works after the guard', async () => {
    const singleCtx = makeMockCtx({
      config: {
        agentLoop: {
          enabled: true,
          every: '60s',
          maxConcurrent: 2,
          strategist: { enabled: false, everyCycles: 3, minInterval: '1h' },
        },
        bots: [{ id: 'bot1', name: 'Bot 1' }],
      },
      runningBots: new Set(['bot1']),
    });

    let callCount = 0;
    const trackingRunFn = vi.fn().mockImplementation(async () => {
      callCount++;
      return makeResult();
    });

    const scheduler = new AgentScheduler(singleCtx, trackingRunFn);
    scheduler.start();

    // Wait for first execution
    await new Promise((r) => setTimeout(r, 500));
    expect(callCount).toBe(1);

    // Request immediate run for bot1 specifically — this sets nextRunAt = now
    scheduler.requestImmediateRun('bot1');

    // Wait — bot should run again because requestImmediateRun set nextRunAt to now
    await new Promise((r) => setTimeout(r, 1500));
    expect(callCount).toBeGreaterThanOrEqual(2);

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Fix 2: loadFromDisk reconciliation — stale nextCheckIn corrected
// ---------------------------------------------------------------------------

describe('AgentScheduler — loadFromDisk reconciliation (Fix 2)', () => {
  let ctx: ReturnType<typeof makeMockCtx>;
  let runOneBotFn: ReturnType<typeof vi.fn>;
  let tmpDir: string;

  beforeEach(() => {
    ctx = makeMockCtx();
    runOneBotFn = vi.fn().mockResolvedValue(makeResult());
    tmpDir = join(
      tmpdir(),
      `agent-scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  test('reconciles stale nextCheckIn with current config on load', () => {
    // Simulate a persisted schedule where bot2 has nextCheckIn: "6h"
    // but the current config says every: "2h"
    const lastRunAt = Date.now() - 3_600_000; // 1h ago
    const staleSchedule: Record<string, Omit<BotSchedule, 'lastResult'>> = {
      bot2: {
        nextRunAt: lastRunAt + 6 * 3_600_000, // based on stale 6h interval
        lastRunAt,
        nextCheckIn: '6h', // stale — config says "2h"
        strategistCycleCount: 0,
        lastStrategistAt: null,
        lastFocus: null,
        continuousCycleCount: 0,
        sessionStartAt: null,
        recentActions: [],
        consecutiveIdleCycles: 0,
        lastLoggedSummary: null,
        retryCount: 0,
        lastErrorMessage: null,
        cyclesSinceAskHuman: 0,
      },
    };

    writeFileSync(join(tmpDir, 'schedules.json'), JSON.stringify(staleSchedule), 'utf-8');

    const scheduler = new AgentScheduler(ctx, runOneBotFn, tmpDir);

    const sched = scheduler.getSchedule('bot2')!;
    expect(sched.nextCheckIn).toBe('2h'); // reconciled to config
    expect(sched.nextRunAt).toBe(lastRunAt + 2 * 3_600_000); // recalculated based on 2h

    // Verify reconciliation was logged
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot2', stale: '6h', current: '2h' }),
      expect.stringContaining('reconciling stale nextCheckIn')
    );
  });

  test('does not modify schedule when nextCheckIn matches config', () => {
    const lastRunAt = Date.now() - 3_600_000;
    const correctSchedule: Record<string, Omit<BotSchedule, 'lastResult'>> = {
      bot2: {
        nextRunAt: lastRunAt + 2 * 3_600_000,
        lastRunAt,
        nextCheckIn: '2h', // matches config
        strategistCycleCount: 0,
        lastStrategistAt: null,
        lastFocus: null,
        continuousCycleCount: 0,
        sessionStartAt: null,
        recentActions: [],
        consecutiveIdleCycles: 0,
        lastLoggedSummary: null,
        retryCount: 0,
        lastErrorMessage: null,
        cyclesSinceAskHuman: 0,
      },
    };

    writeFileSync(join(tmpDir, 'schedules.json'), JSON.stringify(correctSchedule), 'utf-8');

    const scheduler = new AgentScheduler(ctx, runOneBotFn, tmpDir);

    const sched = scheduler.getSchedule('bot2')!;
    expect(sched.nextCheckIn).toBe('2h');
    expect(sched.nextRunAt).toBe(lastRunAt + 2 * 3_600_000); // unchanged

    // No reconciliation log
    expect(ctx.logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot2' }),
      expect.stringContaining('reconciling')
    );
  });

  test('uses global config.agentLoop.every for bots without per-bot override', () => {
    const lastRunAt = Date.now() - 3_600_000;
    const staleSchedule: Record<string, Omit<BotSchedule, 'lastResult'>> = {
      bot1: {
        nextRunAt: lastRunAt + 3 * 3_600_000, // based on stale 3h interval
        lastRunAt,
        nextCheckIn: '3h', // stale — global config says "6h"
        strategistCycleCount: 0,
        lastStrategistAt: null,
        lastFocus: null,
        continuousCycleCount: 0,
        sessionStartAt: null,
        recentActions: [],
        consecutiveIdleCycles: 0,
        lastLoggedSummary: null,
        retryCount: 0,
        lastErrorMessage: null,
        cyclesSinceAskHuman: 0,
      },
    };

    writeFileSync(join(tmpDir, 'schedules.json'), JSON.stringify(staleSchedule), 'utf-8');

    const scheduler = new AgentScheduler(ctx, runOneBotFn, tmpDir);

    const sched = scheduler.getSchedule('bot1')!;
    expect(sched.nextCheckIn).toBe('6h'); // reconciled to global config
    expect(sched.nextRunAt).toBe(lastRunAt + 6 * 3_600_000);
  });

  test('handles null nextCheckIn in persisted schedule (no reconciliation needed)', () => {
    const staleSchedule: Record<string, Omit<BotSchedule, 'lastResult'>> = {
      bot1: {
        nextRunAt: Date.now() + 300_000,
        lastRunAt: null,
        nextCheckIn: null, // first run — no nextCheckIn yet
        strategistCycleCount: 0,
        lastStrategistAt: null,
        lastFocus: null,
        continuousCycleCount: 0,
        sessionStartAt: null,
        recentActions: [],
        consecutiveIdleCycles: 0,
        lastLoggedSummary: null,
        retryCount: 0,
        lastErrorMessage: null,
        cyclesSinceAskHuman: 0,
      },
    };

    writeFileSync(join(tmpDir, 'schedules.json'), JSON.stringify(staleSchedule), 'utf-8');

    // Should not throw or reconcile
    const scheduler = new AgentScheduler(ctx, runOneBotFn, tmpDir);
    const sched = scheduler.getSchedule('bot1')!;
    expect(sched.nextCheckIn).toBeNull();
  });
});

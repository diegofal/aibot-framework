import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createStatsContext } from '../../src/stats/context';
import { buildBotDetail, buildBotStats, buildFleet } from '../../src/stats/fleet-aggregator';
import { removeTempDir } from '../helpers/temp-dir';
import { DAY, H, type StatsFixture, createStatsFixture } from './fixture';

let fx: StatsFixture;
beforeEach(() => {
  fx = createStatsFixture();
});
afterEach(() => removeTempDir(fx.dir));

const iso = (ms: number) => new Date(ms).toISOString();

describe('buildBotStats — busy bot (b1)', () => {
  it('fills every section of the contract from disk', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const s = buildBotStats(ctx, fx.bots.b1, '7d');

    expect(s.botId).toBe('b1');
    expect(s.name).toBe('Bot One');
    expect(s.enabled).toBe(true);
    expect(s.backend).toBe('ollama');
    expect(s.model).toBe('qwen');
    expect(s.channel).toEqual({ kind: 'telegram', state: 'configured' });

    expect(s.loop).toEqual({
      cadence: '6h',
      mode: 'periodic',
      nextRunAt: fx.now + 5 * H,
      lastRunAt: fx.now - H,
      consecutiveIdleCycles: 0,
      retryCount: 0,
      lastError: null,
    });
    expect(s.posture).toBe('active');
    expect(s.lastHumanContactAt).toBe(iso(fx.now - 6 * H + 5 * 60_000));

    expect(s.llm.calls).toBe(3);
    expect(s.llm.failed).toBe(1);
    expect(s.llm.promptTokens).toBe(300);
    expect(s.llm.completionTokens).toBe(30);
    expect(s.llm.byCaller.executor).toEqual({ calls: 2, failed: 1 });
    expect(s.llm.byModel.qwen.calls).toBe(3);
    expect(s.llm.lastError).toBe('HTTP 429 Too Many Requests');
    expect(s.llm.lastCallAt).toBe(iso(fx.now - H));

    expect(s.tools.calls).toBe(6);
    expect(s.tools.failed).toBe(1);
    expect(s.tools.top[0]).toEqual({ name: 'file_write', count: 2, failed: 0 });
    expect(s.tools.loopBreaks).toBe(1);

    expect(s.output).toEqual({
      filesActive: 1,
      filesArchived: 1,
      approved: 1,
      rejected: 0,
      unreviewed: 1,
      outcomesProduced: 2,
      outcomesStale: 1,
      lastFileAt: iso(fx.now - DAY),
    });

    expect(s.engagement).toEqual({
      asksSent: 2,
      asksAnswered: 1,
      asksPending: 1,
      asksClosedUnanswered: 0,
      messagesSentProactive: 1,
      collaborateCalls: 1,
      collaborateFailed: 1,
      meshPublished: 1,
    });

    expect(s.goals.active).toBe(2);
    expect(s.goals.completed).toBe(1);
    expect(s.goals.byStatus).toEqual({ in_progress: 1, pending: 1 });
    expect(s.goals.lastCompletedAt).toBe('2026-08-01');

    expect(s.karma).toEqual({ score: null, delta: 3, events: 1 });

    expect(s.traits.current).toEqual({ curiosity: 0.7, caution: 0.5 });
    expect(s.traits.drift).toEqual({ curiosity: 0.2, caution: 0 });
    expect(s.traits.adjustments).toBe(2);

    expect(s.soul.lastReflectionAt).toBe('2026-08-15');
    expect(s.soul.lastHealthCheckAt).toBe(iso(fx.now - DAY));
    expect(s.soul.memoryBytes).toBe(14);
    expect(s.soul.dailyLogsPending).toBe(1);
    expect(s.soul.soulEqualsMotivations).toBe(false);
    expect(s.soul.missingFiles).toEqual([]);

    expect(s.cycles).toEqual({ total: 2, idle: 1, avgDurationMs: 3000, alignmentWarnings: 1 });
  });

  it('narrows window-bound counters for 24h', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const s = buildBotStats(ctx, fx.bots.b1, '24h');
    expect(s.output.outcomesProduced).toBe(1);
    expect(s.output.outcomesStale).toBe(0);
    expect(s.llm.calls).toBe(3);
  });

  it('prefers live scheduler state and karma service when wired', () => {
    const ctx = createStatsContext({
      config: fx.config,
      now: () => fx.now,
      karmaService: { getScore: () => 57 },
      botManager: {
        getAgentLoopState: () =>
          ({
            running: true,
            sleeping: false,
            draining: false,
            lastRunAt: null,
            lastResults: [],
            nextRunAt: null,
            botSchedules: [
              {
                botId: 'b1',
                botName: 'Bot One',
                mode: 'continuous',
                backend: 'ollama',
                nextRunAt: fx.now + 60_000,
                lastRunAt: fx.now - 30_000,
                nextCheckIn: '1h',
                lastStatus: 'completed',
                lastStrategistAt: null,
                lastFocus: null,
                strategistCyclesUntilNext: 3,
                continuousCycleCount: 12,
                isIdle: false,
                consecutiveIdleCycles: 2,
                recentActionsSummary: [],
                retryCount: 1,
                lastErrorMessage: 'hiccup',
                isExecutingLoop: false,
              },
            ],
          }) as never,
      },
    });
    const s = buildBotStats(ctx, fx.bots.b1, '7d');
    expect(s.loop).toEqual({
      cadence: '1h',
      mode: 'continuous',
      nextRunAt: fx.now + 60_000,
      lastRunAt: fx.now - 30_000,
      consecutiveIdleCycles: 2,
      retryCount: 1,
      lastError: 'hiccup',
    });
    expect(s.karma.score).toBe(57);
  });

  it('falls back to the persisted schedule for lastRunAt/nextRunAt right after a restart', () => {
    const ctx = createStatsContext({
      config: fx.config,
      now: () => fx.now,
      botManager: {
        getAgentLoopState: () =>
          ({
            running: true,
            sleeping: false,
            draining: false,
            lastRunAt: null,
            lastResults: [],
            nextRunAt: null,
            botSchedules: [
              {
                botId: 'b1',
                botName: 'Bot One',
                mode: 'periodic',
                backend: 'ollama',
                nextRunAt: null,
                lastRunAt: null,
                nextCheckIn: '6h',
                lastStatus: 'idle',
                lastStrategistAt: null,
                lastFocus: null,
                strategistCyclesUntilNext: 3,
                continuousCycleCount: 0,
                isIdle: false,
                consecutiveIdleCycles: 0,
                recentActionsSummary: [],
                retryCount: 0,
                lastErrorMessage: null,
                isExecutingLoop: false,
              },
            ],
          }) as never,
      },
    });
    const s = buildBotStats(ctx, fx.bots.b1, '7d');
    // fixture's schedules.json has b1.lastRunAt = now - 1h
    expect(s.loop.lastRunAt).toBe(fx.now - 3_600_000);
    expect(s.posture).not.toBe('unknown');
  });

  it('prefers the channel status recorded by the bot manager when exposed', () => {
    const ctx = createStatsContext({
      config: fx.config,
      now: () => fx.now,
      botManager: {
        getChannelState: () => ({
          kind: 'telegram',
          state: 'ok',
          lastError: null,
          checkedAt: null,
        }),
      },
    });
    expect(buildBotStats(ctx, fx.bots.b1, '7d').channel).toEqual({ kind: 'telegram', state: 'ok' });
  });
  it('passes the recorded "error" state through (non-401 Telegram start failure)', () => {
    const ctx = createStatsContext({
      config: fx.config,
      now: () => fx.now,
      botManager: {
        getChannelState: () => ({ kind: 'headless', state: 'error', lastError: 'ECONNRESET' }),
      },
    });
    expect(buildBotStats(ctx, fx.bots.b1, '7d').channel).toEqual({
      kind: 'headless',
      state: 'error',
    });
  });
  it('maps a recorded state outside the vocabulary to unknown', () => {
    const ctx = createStatsContext({
      config: fx.config,
      now: () => fx.now,
      botManager: {
        getChannelState: () => ({ kind: 'headless', state: 'weird', lastError: null }),
      },
    });
    expect(buildBotStats(ctx, fx.bots.b1, '7d').channel.state).toBe('unknown');
  });
});

describe('buildBotStats — empty bots', () => {
  it('disabled bot with no data is dormant with zeros and nulls everywhere', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const s = buildBotStats(ctx, fx.bots.b2, '7d');
    expect(s.enabled).toBe(false);
    expect(s.backend).toBe('claude-cli');
    expect(s.model).toBe('claude-sonnet');
    expect(s.channel).toEqual({ kind: 'headless', state: 'missing' });
    expect(s.posture).toBe('dormant');
    expect(s.loop.lastRunAt).toBeNull();
    expect(s.lastHumanContactAt).toBeNull();
    expect(s.llm.calls).toBe(0);
    expect(s.tools.top).toEqual([]);
    expect(s.output.filesActive).toBe(0);
    expect(s.engagement.asksSent).toBe(0);
    expect(s.goals.active).toBe(0);
    expect(s.karma).toEqual({ score: null, delta: 0, events: 0 });
    expect(s.traits).toEqual({ current: null, baseline: null, drift: null, adjustments: 0 });
    expect(s.soul.missingFiles).toHaveLength(5);
    expect(s.cycles).toEqual({ total: 0, idle: 0, avgDurationMs: 0, alignmentWarnings: 0 });
  });

  it('telegram 401 in the logs marks the channel revoked + headless, retry storm → blocked', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const s = buildBotStats(ctx, fx.bots.b3, '7d');
    expect(s.channel).toEqual({ kind: 'headless', state: 'revoked' });
    expect(s.posture).toBe('blocked');
    expect(s.loop.retryCount).toBe(4);
  });
});

describe('buildFleet', () => {
  it('sums totals across bots and stamps window + generatedAt', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const f = buildFleet(ctx, [fx.bots.b1, fx.bots.b2, fx.bots.b3], '7d');
    expect(f.window).toBe('7d');
    expect(f.generatedAt).toBe(iso(fx.now));
    expect(f.bots.map((b) => b.botId)).toEqual(['b1', 'b2', 'b3']);
    expect(f.totals).toEqual({
      llmCalls: 3,
      llmFailed: 1,
      toolCalls: 6,
      toolFailed: 1,
      promptTokens: 300,
      completionTokens: 30,
      filesActive: 1,
      unreviewed: 1,
      asksPending: 1,
      cycles: 2,
    });
  });
});

describe('buildBotDetail', () => {
  it('adds goals, traits history, cycles, daily series, asks and top errors', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const d = buildBotDetail(ctx, fx.bots.b1, '7d');
    expect(d.botId).toBe('b1');
    expect(d.window).toBe('7d');
    expect(d.goalsDetail).toHaveLength(3);
    expect(d.goalsDetail[0].section).toBe('active');
    expect(d.traitHistory).toHaveLength(2);
    expect(d.recentCycles.actions).toHaveLength(1);
    expect(d.recentCycles.lastLoggedSummary).toBe('Wrote the weekly digest');
    expect(d.llmDaily.reduce((n, x) => n + x.calls, 0)).toBe(3);
    expect(d.toolsDaily.reduce((n, x) => n + x.calls, 0)).toBe(6);
    expect(d.asks).toHaveLength(2);
    expect(d.asks.find((a) => a.id === 'c1')?.questionChars).toBe(400);
    expect(d.topErrors).toEqual([{ message: 'HTTP N Too Many Requests', count: 1 }]);
  });
  it('works for a bot with nothing on disk', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const d = buildBotDetail(ctx, fx.bots.b2, '7d');
    expect(d.goalsDetail).toEqual([]);
    expect(d.traitHistory).toEqual([]);
    expect(d.recentCycles).toEqual({ actions: [], lastLoggedSummary: null });
    expect(d.llmDaily).toEqual([]);
    expect(d.asks).toEqual([]);
    expect(d.topErrors).toEqual([]);
  });
});

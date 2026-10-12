import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createStatsContext } from '../../src/stats/context';
import { buildCycleDetail } from '../../src/stats/cycle-detail';
import { type GoalDetailFixture, LAB_GOAL, createGoalDetailFixture } from './goal-detail-fixture';

let fx: GoalDetailFixture;
beforeEach(() => {
  fx = createGoalDetailFixture();
});
afterEach(() => rmSync(fx.dir, { recursive: true, force: true }));

const ctxOf = () => createStatsContext({ config: fx.config, now: () => fx.now });

describe('buildCycleDetail', () => {
  it('one recorded cycle: its rows, its goal, its plan', () => {
    const d = buildCycleDetail(ctxOf(), fx.bot, 'c-exact');
    expect(d?.botId).toBe('g1');
    expect(d?.goal).toEqual({ id: 'g-lab00001', title: LAB_GOAL });
    const c = d?.cycle;
    expect(c?.cycleId).toBe('c-exact');
    expect(c?.attribution).toBe('exact');
    expect(c?.planSummary).toBe('Draft the October lab');
    expect(c?.status).toBe('completed');
    expect(c?.llmCalls.map((l) => l.caller)).toEqual(['planner', 'executor']);
    expect(c?.toolCalls.map((t) => t.name)).toEqual(['file_write', 'manage_goals']);
    expect(c?.productions).toEqual([
      expect.objectContaining({ path: '05_monthly_lab.md', action: 'edit', review: 'pending' }),
    ]);
    expect(c?.asks.map((a) => a.title)).toEqual(['Which skill for the October lab?']);
  });

  it('matches the goal drawer for the same cycle', async () => {
    const { buildGoalDetail } = await import('../../src/stats/goal-detail-aggregator');
    const fromGoal = buildGoalDetail(ctxOf(), fx.bot, { id: 'g-lab00001', days: 14 })?.cycles[0];
    expect(buildCycleDetail(ctxOf(), fx.bot, 'c-exact')?.cycle).toEqual(fromGoal);
  });

  it('says why: the recorded reason in plain words, the strategist reflection and trait deltas', () => {
    const start = fx.now - 2 * 3_600_000;
    const dir = join(fx.dir, 'agent-cycles', 'g1');
    mkdirSync(dir, { recursive: true });
    const row = (over: Record<string, unknown>) =>
      `${JSON.stringify({
        botId: 'g1',
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + 1000).toISOString(),
        toolCalls: 0,
        tools: [],
        goalId: null,
        goalTitle: null,
        ...over,
      })}\n`;
    appendFileSync(
      join(dir, `${new Date(start).toISOString().slice(0, 10)}.jsonl`),
      row({
        cycleId: 'c-idle',
        status: 'idle',
        reason: 'Waiting for feedback.',
        reasonSource: 'planner',
        strategistRan: true,
        reflection: 'Too much output, no readers.',
        traitAdjustments: { caution: 0.03 },
      }) +
        row({
          cycleId: 'c-skip',
          status: 'skipped',
          reason: 'circuit-open:claude-cli',
          reasonSource: 'circuit-breaker',
          strategistRan: false,
        })
    );
    const idle = buildCycleDetail(ctxOf(), fx.bot, 'c-idle');
    expect(idle?.cycleReason).toEqual({ text: 'Waiting for feedback.', source: 'Planner' });
    expect(idle?.strategistRan).toBe(true);
    expect(idle?.reflection).toBe('Too much output, no readers.');
    expect(idle?.traitAdjustments).toEqual({ caution: 0.03 });
    const skip = buildCycleDetail(ctxOf(), fx.bot, 'c-skip');
    expect(skip?.cycleReason).toEqual({
      text: 'The claude-cli circuit breaker was open after repeated quota/429 errors, so the cycle sat out.',
      source: 'Circuit breaker',
    });
    expect(skip?.reflection).toBeNull();
    const old = buildCycleDetail(ctxOf(), fx.bot, 'c-exact');
    expect(old?.cycleReason).toBeNull();
    expect(old?.strategistRan).toBeNull();
  });

  it('an unknown cycle is null', () => {
    expect(buildCycleDetail(ctxOf(), fx.bot, 'c-nope')).toBeNull();
    expect(buildCycleDetail(ctxOf(), fx.bot, '')).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
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

  it('an unknown cycle is null', () => {
    expect(buildCycleDetail(ctxOf(), fx.bot, 'c-nope')).toBeNull();
    expect(buildCycleDetail(ctxOf(), fx.bot, '')).toBeNull();
  });
});

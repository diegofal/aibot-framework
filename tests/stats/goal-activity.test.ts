import { describe, expect, test } from 'bun:test';
import {
  GOAL_ACTIVITY_DAYS,
  buildGoalActivity,
  loopIntervalMs,
} from '../../src/stats/goal-activity';
import type { AgentCycleRecord } from '../../src/stats/readers/agent-cycles';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.parse('2026-10-12T12:00:00Z');

function cyc(goalId: string | null, agoMs: number, status = 'completed'): AgentCycleRecord {
  return {
    cycleId: `c-${goalId}-${agoMs}`,
    startedAt: new Date(NOW - agoMs).toISOString(),
    status,
    goalId,
  };
}

describe('buildGoalActivity', () => {
  test('last cycle, 7-day count and one bar per day, oldest first', () => {
    const out = buildGoalActivity(
      [cyc('g-a', 8 * H), cyc('g-a', 30 * H), cyc('g-a', 31 * H), cyc('g-a', 10 * DAY)],
      NOW
    );
    expect(out['g-a'].lastCycleAt).toBe(new Date(NOW - 8 * H).toISOString());
    expect(out['g-a'].cycles7d).toBe(3);
    expect(out['g-a'].daily).toHaveLength(GOAL_ACTIVITY_DAYS);
    expect(out['g-a'].daily).toEqual([0, 0, 0, 0, 0, 2, 1]);
  });

  test('a goal only worked on long ago still has its last cycle, no recent bars', () => {
    const out = buildGoalActivity([cyc('g-old', 12 * DAY)], NOW);
    expect(out['g-old'].lastCycleAt).toBe(new Date(NOW - 12 * DAY).toISOString());
    expect(out['g-old'].cycles7d).toBe(0);
    expect(out['g-old'].daily).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test('idle and skipped cycles did no work; cycles without a goal are ignored', () => {
    const out = buildGoalActivity(
      [cyc('g-a', H, 'idle'), cyc('g-a', 2 * H, 'skipped'), cyc(null, H), cyc('g-a', 5 * H)],
      NOW
    );
    expect(Object.keys(out)).toEqual(['g-a']);
    expect(out['g-a'].cycles7d).toBe(1);
    expect(out['g-a'].lastCycleAt).toBe(new Date(NOW - 5 * H).toISOString());
  });

  test('error cycles count: the agent tried', () => {
    const out = buildGoalActivity([cyc('g-a', H, 'error')], NOW);
    expect(out['g-a'].cycles7d).toBe(1);
  });

  test('order of the log does not matter for the last cycle', () => {
    const out = buildGoalActivity([cyc('g-a', 2 * H), cyc('g-a', 9 * H), cyc('g-a', H)], NOW);
    expect(out['g-a'].lastCycleAt).toBe(new Date(NOW - H).toISOString());
  });

  test('bad timestamps are skipped', () => {
    const out = buildGoalActivity(
      [{ cycleId: 'x', startedAt: 'nope', status: 'completed', goalId: 'g-a' }],
      NOW
    );
    expect(out).toEqual({});
  });
});

describe('loopIntervalMs', () => {
  test("the bot's own `every` wins", () => {
    expect(
      loopIntervalMs(
        { agentLoop: { every: '24h' } } as never,
        { agentLoop: { every: '6h' } } as never
      )
    ).toBe(24 * H);
  });
  test('falls back to the global `every`', () => {
    expect(loopIntervalMs({} as never, { agentLoop: { every: '6h' } } as never)).toBe(6 * H);
  });
  test('unparseable or missing → 24h', () => {
    expect(loopIntervalMs({ agentLoop: { every: 'soon' } } as never, {} as never)).toBe(DAY);
    expect(loopIntervalMs({} as never, {} as never)).toBe(DAY);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  GOAL_ACTIVITY_DAYS,
  buildGoalActivity,
  goalTurnIntervalMs,
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

// The bot works one goal per cycle, and explore cycles serve none: judged
// against the raw loop interval, every goal of a bot with 4 goals and a 2 h
// loop read "stalled" most of the time.
describe('goalTurnIntervalMs', () => {
  const served = (n: number, step = H) => Array.from({ length: n }, (_, i) => cyc('g-a', i * step));
  const unserved = (n: number, step = H) =>
    Array.from({ length: n }, (_, i) => cyc(null, i * step + 1));

  test('the loop interval times the goals that share it', () => {
    expect(goalTurnIntervalMs({ loopMs: 2 * H, goalCount: 4, cycles: served(8), nowMs: NOW })).toBe(
      8 * H
    );
  });

  test('cycles that served no goal stretch the turn', () => {
    const cycles = [...served(5), ...unserved(5)];
    expect(goalTurnIntervalMs({ loopMs: 2 * H, goalCount: 4, cycles, nowMs: NOW })).toBe(16 * H);
  });

  test('idle and skipped cycles count as cycles that served no goal', () => {
    const cycles = [...served(5), cyc('g-a', 30 * H, 'idle'), ...unserved(4)];
    expect(goalTurnIntervalMs({ loopMs: 2 * H, goalCount: 1, cycles, nowMs: NOW })).toBe(4 * H);
  });

  test('cycles older than 7 days are not counted', () => {
    const cycles = [
      ...served(4),
      ...unserved(10, 0).map((c) => ({ ...c, startedAt: new Date(NOW - 8 * DAY).toISOString() })),
    ];
    expect(goalTurnIntervalMs({ loopMs: H, goalCount: 2, cycles, nowMs: NOW })).toBe(2 * H);
  });

  test('too few cycles to judge: no stretch; never below one goal; share floored at a quarter', () => {
    expect(goalTurnIntervalMs({ loopMs: H, goalCount: 3, cycles: unserved(3), nowMs: NOW })).toBe(
      3 * H
    );
    expect(goalTurnIntervalMs({ loopMs: H, goalCount: 0, cycles: [], nowMs: NOW })).toBe(H);
    expect(goalTurnIntervalMs({ loopMs: H, goalCount: 1, cycles: unserved(10), nowMs: NOW })).toBe(
      4 * H
    );
  });
});

/**
 * Standing goals get a turn: the planner is told which standing goals are due
 * a round (no completed cycle served them within one turn), most overdue
 * first, and the board shows such a goal as "round due" instead of "stalled".
 */
import { describe, expect, test } from 'bun:test';
import { buildContinuousPlannerPrompt, buildPlannerPrompt } from '../../src/bot/agent-loop-prompts';
import {
  STANDING_TURN_FLOOR_MS,
  buildStandingDueSection,
  dueStandingGoals,
  standingTurnIntervalMs,
} from '../../src/goals/standing-rotation';
import type { AgentCycleRecord } from '../../src/stats/readers/agent-cycles';
import { parseGoals } from '../../src/tools/goals';
import { cardHtml, goalPulse } from '../../web/pages/fleet-board-helpers.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.parse('2026-10-15T12:00:00Z');
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const md = `## Active Goals
- [ ] Purpose: be the operator's factory
  - status: in_progress
  - priority: high
  - id: g-purpose0
- [ ] Keep one clean list of open loops
  - status: in_progress
  - priority: medium
  - kind: standing
  - id: g-standin1
- [ ] Learn the operator's routine
  - status: pending
  - priority: medium
  - kind: standing
  - id: g-standin2
- [ ] Read two sources a day
  - status: blocked
  - priority: low
  - kind: standing
  - id: g-standin3
`;
const goals = parseGoals(md).active;

const cycle = (goalId: string, agoMs: number, status = 'completed'): AgentCycleRecord => ({
  cycleId: `c-${goalId}-${agoMs}`,
  startedAt: iso(agoMs),
  status,
  goalId,
});

describe('dueStandingGoals', () => {
  test('a standing goal never served is due, with lastRoundAt null', () => {
    const due = dueStandingGoals({ goals, cycles: [], nowMs: NOW, turnMs: DAY });
    expect(due.map((d) => d.goalId)).toEqual(['g-standin1', 'g-standin2', 'g-standin3']);
    expect(due[0]).toEqual({
      goalId: 'g-standin1',
      title: 'Keep one clean list of open loops',
      lastRoundAt: null,
    });
  });

  test('served within the turn: not due; served long ago: due', () => {
    const due = dueStandingGoals({
      goals,
      cycles: [cycle('g-standin1', 3 * H), cycle('g-standin2', 3 * DAY)],
      nowMs: NOW,
      turnMs: DAY,
    });
    expect(due.map((d) => d.goalId)).toEqual(['g-standin3', 'g-standin2']);
    expect(due[1].lastRoundAt).toBe(iso(3 * DAY));
  });

  test('idle and skipped cycles are not a round', () => {
    const due = dueStandingGoals({
      goals,
      cycles: [cycle('g-standin1', H, 'idle'), cycle('g-standin1', 2 * H, 'skipped')],
      nowMs: NOW,
      turnMs: DAY,
    });
    expect(due.find((d) => d.goalId === 'g-standin1')?.lastRoundAt).toBeNull();
  });

  test('non-standing goals are never listed, however long they wait', () => {
    const due = dueStandingGoals({ goals, cycles: [], nowMs: NOW, turnMs: DAY });
    expect(due.some((d) => d.goalId === 'g-purpose0')).toBe(false);
  });

  test('never served first, then the oldest round first', () => {
    const due = dueStandingGoals({
      goals,
      cycles: [cycle('g-standin1', 2 * DAY), cycle('g-standin3', 5 * DAY)],
      nowMs: NOW,
      turnMs: DAY,
    });
    expect(due.map((d) => d.goalId)).toEqual(['g-standin2', 'g-standin3', 'g-standin1']);
  });

  test('the turn interval has a 24 h floor', () => {
    expect(STANDING_TURN_FLOOR_MS).toBe(DAY);
    expect(standingTurnIntervalMs({ loopMs: H, goals, cycles: [], nowMs: NOW })).toBe(DAY);
    // 3 servable goals (blocked excluded) × 1 d loop
    expect(standingTurnIntervalMs({ loopMs: DAY, goals, cycles: [], nowMs: NOW })).toBe(3 * DAY);
  });
});

describe('planner block: Standing goals due', () => {
  const due = dueStandingGoals({
    goals,
    cycles: [cycle('g-standin1', 3 * DAY)],
    nowMs: NOW,
    turnMs: DAY,
  });

  test('lists each due goal with its last round and the rotation rule', () => {
    const text = buildStandingDueSection(due, NOW);
    expect(text).toContain('## Standing goals due');
    expect(text).toContain("[g-standin2] Learn the operator's routine — last round never");
    expect(text).toContain('[g-standin1] Keep one clean list of open loops — last round 3d ago');
    expect(text).toContain('serves_goal');
    expect(text).toContain('set by your operator');
    expect(buildStandingDueSection([], NOW)).toBe('');
  });

  const base = {
    identity: 'TestBot',
    soul: 'A bot',
    motivations: 'Be helpful',
    goals: md,
    recentMemory: 'Did stuff',
    datetime: '2026-10-15T12:00:00Z',
    availableTools: ['web_search'],
    hasCreateTool: false,
  };

  test('present in both planner modes when goals are due, absent otherwise', () => {
    for (const build of [buildPlannerPrompt, buildContinuousPlannerPrompt]) {
      const withDue = build({ ...base, standingDue: due, nowMs: NOW } as never).system;
      expect(withDue).toContain('## Standing goals due');
      expect(withDue).toContain("[g-standin2] Learn the operator's routine — last round never");
      expect(build(base as never).system).not.toContain('## Standing goals due');
      expect(build({ ...base, standingDue: [] } as never).system).not.toContain(
        '## Standing goals due'
      );
    }
  });
});

describe('board: a standing goal is "round due", not "stalled"', () => {
  const act = (agoMs: number) => ({
    lastCycleAt: iso(agoMs),
    cycles7d: 1,
    daily: [0, 0, 0, 1, 0, 0, 0],
  });

  test('goalPulse turns stalled into due for a standing goal only', () => {
    expect(goalPulse(act(4 * DAY), DAY, NOW, { standing: true })).toMatchObject({
      tone: 'due',
      text: 'round due · 4d ago',
    });
    expect(goalPulse(undefined, DAY, NOW, { standing: true })).toMatchObject({
      tone: 'due',
      text: 'round due · never',
    });
    // fresh and quiet stay as they are
    expect(goalPulse(act(2 * H), DAY, NOW, { standing: true }).tone).toBe('fresh');
    expect(goalPulse(act(2 * DAY), DAY, NOW, { standing: true }).tone).toBe('quiet');
    // a project goal still stalls
    expect(goalPulse(act(4 * DAY), DAY, NOW).tone).toBe('stalled');
  });

  test('cardHtml uses the due tone for an in-progress standing goal', () => {
    const g = {
      id: 'g-standin1',
      text: 'Keep one clean list of open loops',
      status: 'in_progress',
      priority: 'medium',
      section: 'active',
      kind: 'standing',
      tasks: [],
    };
    const ctx = { activity: { 'g-standin1': act(4 * DAY) }, intervalMs: DAY, nowMs: NOW };
    const html = cardHtml(g, false, ctx);
    expect(html).toContain('fb-gpulse due');
    expect(html).toContain('round due · 4d ago');
    const project = cardHtml({ ...g, kind: null }, false, ctx);
    expect(project).toContain('fb-gpulse stalled');
  });
});

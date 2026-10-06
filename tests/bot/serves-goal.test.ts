/**
 * The planner and strategist may name the goal a cycle serves (`serves_goal`).
 * Record only: a missing or unknown goal is unattributed, never a retry.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildContinuousPlannerPrompt,
  buildPlannerPrompt,
  buildStrategistPrompt,
} from '../../src/bot/agent-loop-prompts';
import { parsePlannerResult } from '../../src/bot/agent-planner';
import { parseStrategistResult } from '../../src/bot/agent-strategist';
import { type GoalEntry, goalFromManageGoalsArgs, resolveGoalRef } from '../../src/tools/goals';

const warn = { warn: () => {} };

const goals: GoalEntry[] = [
  {
    text: 'Weekly AI Engineer brief every Monday',
    status: 'pending',
    priority: 'high',
    id: 'g-aaaaaaaa',
  },
  { text: 'Monthly hands-on lab', status: 'in_progress', priority: 'medium', id: 'g-bbbbbbbb' },
];

describe('parse serves_goal', () => {
  test('planner keeps serves_goal when it is a non-empty string', () => {
    const r = parsePlannerResult(
      '{"reasoning":"r","plan":["a"],"priority":"high","serves_goal":"Monthly hands-on lab"}',
      warn
    );
    expect(r?.serves_goal).toBe('Monthly hands-on lab');
    const none = parsePlannerResult(
      '{"reasoning":"r","plan":["a"],"priority":"high","serves_goal":42}',
      warn
    );
    expect(none).not.toBeNull();
    expect(none?.serves_goal).toBeUndefined();
  });

  test('strategist keeps serves_goal', () => {
    const r = parseStrategistResult(
      '{"goal_operations":[],"single_deliverable":"d","reflection":"x","serves_goal":"g-aaaaaaaa"}',
      warn
    );
    expect(r?.serves_goal).toBe('g-aaaaaaaa');
  });
});

describe('resolveGoalRef', () => {
  test('exact id, then exact title, then fuzzy; null for unknown or empty', () => {
    expect(resolveGoalRef('g-bbbbbbbb', goals)?.id).toBe('g-bbbbbbbb');
    expect(resolveGoalRef('  weekly ai engineer brief every monday ', goals)?.id).toBe(
      'g-aaaaaaaa'
    );
    expect(resolveGoalRef('hands-on lab', goals)?.id).toBe('g-bbbbbbbb');
    expect(resolveGoalRef('quantum gardening', goals)).toBeNull();
    expect(resolveGoalRef('', goals)).toBeNull();
    expect(resolveGoalRef(undefined, goals)).toBeNull();
  });
});

describe('goalFromManageGoalsArgs', () => {
  test('resolves the goal a manage_goals update/complete call names; ignores list', () => {
    expect(
      goalFromManageGoalsArgs({ action: 'update', goal: 'Monthly hands-on lab' }, goals)?.id
    ).toBe('g-bbbbbbbb');
    expect(goalFromManageGoalsArgs({ action: 'list' }, goals)).toBeNull();
  });
});

describe('prompts ask for serves_goal', () => {
  test('planner (both modes) and strategist schemas mention serves_goal', () => {
    const base = {
      identity: 'i',
      soul: 's',
      motivations: 'm',
      goals: '## Active Goals\n- [ ] A\n',
      recentMemory: '',
      datetime: 'now',
      availableTools: [],
      hasCreateTool: false,
    } as never;
    expect(buildPlannerPrompt(base).system).toContain('serves_goal');
    expect(
      buildContinuousPlannerPrompt({ ...(base as object), lastCycleSummary: null } as never).system
    ).toContain('serves_goal');
    expect(buildStrategistPrompt(base).system).toContain('serves_goal');
  });
});

import { describe, expect, test } from 'bun:test';
import {
  applyPlannerTasks,
  buildTaskOutputSection,
  parsePlannerTaskFields,
} from '../../src/bot/agent-loop-tasks';
import { renderGoalsForPrompt } from '../../src/goals/goals-view';
import { editGoal, parseGoals, serializeGoals } from '../../src/tools/goals';
import { parseGoalEdits } from '../../src/web/routes/agent-home';

const md = `## Active Goals
- [ ] Read at least 2 primary sources per cycle
  - status: in_progress
  - priority: medium
  - kind: standing
  - id: g-aaaaaaaa
- [ ] Fill the skills map with customer scoping sources
  - status: in_progress
  - priority: medium
  - id: g-bbbbbbbb

## Completed
(none yet)
`;

describe('goal kind: standing', () => {
  test('parse and serialize round-trip the kind line; unknown kinds are dropped', () => {
    const { active, completed } = parseGoals(md);
    expect(active[0].kind).toBe('standing');
    expect(active[1].kind).toBeUndefined();
    const again = serializeGoals(active, completed);
    expect(again).toContain('  - kind: standing');
    expect(parseGoals(md.replace('kind: standing', 'kind: weird')).active[0].kind).toBeUndefined();
  });

  test('editGoal sets and clears the kind', () => {
    const cleared = editGoal(md, 'g-aaaaaaaa', { kind: '' }) as string;
    expect(parseGoals(cleared).active[0].kind).toBeUndefined();
    const set = editGoal(md, 'g-bbbbbbbb', { kind: 'standing' }) as string;
    expect(parseGoals(set).active[1].kind).toBe('standing');
  });

  test('the dashboard PATCH accepts kind standing or empty, nothing else', () => {
    expect(parseGoalEdits({ kind: 'standing' })).toEqual({ kind: 'standing' });
    expect(parseGoalEdits({ kind: '' })).toEqual({ kind: '' });
    expect(typeof parseGoalEdits({ kind: 'project' })).toBe('string');
  });

  test('the goals view says which goals are standing and which still need a breakdown', () => {
    const view = renderGoalsForPrompt({ goalsMd: md, tasks: [] });
    const standing = view.slice(view.indexOf('[g-aaaaaaaa]'), view.indexOf('[g-bbbbbbbb]'));
    expect(standing).toContain('standing goal');
    const project = view.slice(view.indexOf('[g-bbbbbbbb]'));
    expect(project).toContain('no tasks yet');
  });
});

describe('planner: breakdown is required for goals with an end state', () => {
  test('the Tasks section makes the breakdown mandatory and explains standing goals', () => {
    const text = buildTaskOutputSection({ workersEnabled: false });
    expect(text).toContain('MUST');
    expect(text).toContain('standing_goal');
    expect(buildTaskOutputSection({ workersEnabled: true })).toContain('single-step');
  });

  test('standing_goal is parsed as a goal reference', () => {
    expect(parsePlannerTaskFields({ standing_goal: ' g-aaaaaaaa ' })).toEqual({
      standing_goal: 'g-aaaaaaaa',
    });
    expect(parsePlannerTaskFields({ standing_goal: 42 })).toEqual({});
  });

  const base = {
    botId: 'b1',
    cycleId: 'c-1',
    goals: parseGoals(md).active,
    exploring: false,
    idle: false,
    gateBlocked: false,
    hardGateActive: false,
    store: { list: () => [], apply: () => ({ ok: true, rev: 1, results: [] }) } as any,
  };

  test('a standing_goal answer marks that goal standing', () => {
    const marked: string[] = [];
    const r = applyPlannerTasks({
      ...base,
      fields: { standing_goal: 'g-bbbbbbbb' },
      markStanding: (g) => {
        marked.push(g.id ?? '');
        return true;
      },
    });
    expect(marked).toEqual(['g-bbbbbbbb']);
    expect(r.standingGoalId).toBe('g-bbbbbbbb');
  });

  test('never on explore, idle or gated cycles', () => {
    for (const skip of [{ exploring: true }, { idle: true }, { gateBlocked: true }]) {
      const marked: string[] = [];
      applyPlannerTasks({
        ...base,
        ...skip,
        fields: { standing_goal: 'g-bbbbbbbb' },
        markStanding: (g) => {
          marked.push(g.id ?? '');
          return true;
        },
      });
      expect(marked).toEqual([]);
    }
  });

  test('an unknown goal is ignored', () => {
    const marked: string[] = [];
    applyPlannerTasks({
      ...base,
      fields: { standing_goal: 'g-nope0000' },
      markStanding: (g) => {
        marked.push(g.id ?? '');
        return true;
      },
    });
    expect(marked).toEqual([]);
  });
});

describe('goal events: kind', () => {
  test('marking a goal standing is one kind event', async () => {
    const { diffGoals } = await import('../../src/bot/goal-events');
    const before = parseGoals(md);
    const after = parseGoals(editGoal(md, 'g-bbbbbbbb', { kind: 'standing' }) as string);
    expect(diffGoals(before, after).map((e) => [e.op, e.to])).toEqual([['kind', 'standing']]);
  });
});

import { describe, expect, test } from 'bun:test';
import { renderGoalsForPrompt } from '../../src/goals/goals-view';
import type { StoredTask } from '../../src/goals/task-store';

const MD = `## Active Goals
- [ ] Research dark factories and write a full brief about the L0-L4 levels
  - status: in_progress
  - priority: high
  - notes: focus on Europe
  - source: operator
  - id: g-aaaaaaaa
- [ ] Write the newsletter
  - status: pending
  - priority: medium
  - source: agent
  - id: g-bbbbbbbb

## Completed
- [x] Old goal
  - completed: 2026-10-01
  - id: g-cccccccc
`;

let n = 0;
function task(
  goalId: string,
  text: string,
  lane: StoredTask['lane'],
  extra: Partial<StoredTask> = {}
): StoredTask {
  n++;
  return {
    id: `t-00000${n}`,
    goalId,
    text,
    lane,
    order: n,
    by: 'agent',
    createdAt: '2026-10-12T00:00:00.000Z',
    cycles: [],
    ...extra,
  };
}

const NOW = Date.parse('2026-10-12T10:00:00.000Z');

describe('renderGoalsForPrompt', () => {
  test('no goals renders empty', () => {
    expect(renderGoalsForPrompt({ goalsMd: null, tasks: [] })).toBe('');
    expect(renderGoalsForPrompt({ goalsMd: '', tasks: [] })).toBe('');
  });

  test('free text with no goals in it is passed through', () => {
    expect(renderGoalsForPrompt({ goalsMd: 'just notes', tasks: [] })).toBe('just notes');
  });

  test('active goals carry id, full text, status, priority, source, notes and open tasks', () => {
    const tasks = [
      task('g-aaaaaaaa', 'Map levels', 'todo'),
      task('g-aaaaaaaa', 'Find companies', 'in_progress', { note: 'two found' }),
      task('g-aaaaaaaa', 'Get approval', 'blocked', {
        claim: { runId: 'r-1', token: 'x', expiresAt: '2026-10-12T11:00:00.000Z' },
      }),
      task('g-aaaaaaaa', 'Old step', 'done'),
      task('g-aaaaaaaa', 'Older step', 'done'),
      task('g-zzzzzzzz', 'Orphan', 'todo'),
    ];
    const out = renderGoalsForPrompt({ goalsMd: MD, tasks, nowMs: NOW });
    expect(out).toContain(
      '- [g-aaaaaaaa] Research dark factories and write a full brief about the L0-L4 levels'
    );
    expect(out).toContain('status: in_progress · priority: high · source: operator');
    expect(out).toContain('notes: focus on Europe');
    expect(out).toContain('[ ] t-000001 Map levels');
    expect(out).toContain('[~] t-000002 Find companies — note: two found');
    expect(out).toContain('[!] t-000003 Get approval (worker running)');
    expect(out).toContain('+2 done');
    expect(out).not.toContain('Old step');
    expect(out).not.toContain('Orphan');
    expect(out).toContain('- [g-bbbbbbbb] Write the newsletter');
    expect(out).toContain('- [g-cccccccc] Old goal (completed 2026-10-01)');
    // Active before completed.
    expect(out.indexOf('Write the newsletter')).toBeLessThan(out.indexOf('Old goal'));
  });

  test('tasks follow their order', () => {
    const tasks = [
      task('g-bbbbbbbb', 'second', 'todo', { order: 2 }),
      task('g-bbbbbbbb', 'first', 'todo', { order: 1 }),
    ];
    const out = renderGoalsForPrompt({ goalsMd: MD, tasks });
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
  });

  test('over budget: completed goals go first, then done counts; ids stay', () => {
    const tasks = [
      task('g-aaaaaaaa', 'Map levels', 'todo', { note: 'n'.repeat(150) }),
      task('g-aaaaaaaa', 'Done one', 'done'),
    ];
    const full = renderGoalsForPrompt({ goalsMd: MD, tasks });
    const noCompleted = renderGoalsForPrompt({ goalsMd: MD, tasks, maxChars: full.length - 1 });
    expect(noCompleted).not.toContain('Old goal');
    expect(noCompleted).toContain('+1 done');
    const noDone = renderGoalsForPrompt({
      goalsMd: MD,
      tasks,
      maxChars: noCompleted.length - 1,
    });
    expect(noDone).not.toContain('+1 done');
    const tiny = renderGoalsForPrompt({ goalsMd: MD, tasks, maxChars: 10 });
    expect(tiny).toContain('g-aaaaaaaa');
    expect(tiny).toContain('g-bbbbbbbb');
    expect(tiny).toContain('t-');
  });
});

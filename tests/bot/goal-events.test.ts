import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GOAL_EVENTS_FILE,
  diffGoals,
  newGoalId,
  readGoalEvents,
  writeGoalsFile,
} from '../../src/bot/goal-events';
import { type GoalEntry, ensureGoalIds, parseGoals, serializeGoals } from '../../src/tools/goals';

const NOW = new Date('2026-10-06T15:00:00.000Z');
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-events-'));
  path = join(dir, 'GOALS.md');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const events = () => readGoalEvents(dir);
const read = () => parseGoals(readFileSync(path, 'utf-8'));

describe('goal ids', () => {
  test('newGoalId is g- plus 8 lowercase hex', () => {
    expect(newGoalId()).toMatch(/^g-[0-9a-f]{8}$/);
    expect(newGoalId()).not.toBe(newGoalId());
  });

  test('parseGoals assigns no ids; ensureGoalIds fills only missing ones', () => {
    const { active, completed } = parseGoals(
      '## Active Goals\n- [ ] A\n  - id: g-aaaaaaaa\n- [ ] B\n\n## Completed\n- [x] C\n'
    );
    expect(active[1].id).toBeUndefined();
    expect(ensureGoalIds(active, completed)).toBe(2);
    expect(active[0].id).toBe('g-aaaaaaaa');
    expect(active[1].id).toMatch(/^g-[0-9a-f]{8}$/);
    expect(completed[0].id).toMatch(/^g-[0-9a-f]{8}$/);
  });

  test('id, started, updated round-trip; completed goals keep their metadata', () => {
    const md = serializeGoals(
      [
        {
          text: 'A',
          status: 'in_progress',
          priority: 'high',
          id: 'g-11111111',
          started: '2026-10-06T14:00:00.000Z',
          updated: '2026-10-06T14:05:00.000Z',
        },
      ],
      [
        {
          text: 'B',
          status: 'completed',
          priority: 'low',
          id: 'g-22222222',
          source: 'operator',
          created: '2026-10-01',
          started: '2026-10-02T00:00:00.000Z',
          notes: 'n',
          completed: '2026-10-03',
          outcome: 'ok',
        },
      ]
    );
    const { active, completed } = parseGoals(md);
    expect(active[0]).toMatchObject({
      id: 'g-11111111',
      started: '2026-10-06T14:00:00.000Z',
      updated: '2026-10-06T14:05:00.000Z',
    });
    expect(completed[0]).toMatchObject({
      id: 'g-22222222',
      source: 'operator',
      created: '2026-10-01',
      started: '2026-10-02T00:00:00.000Z',
      priority: 'low',
      notes: 'n',
      completed: '2026-10-03',
      outcome: 'ok',
    });
  });
});

describe('diffGoals', () => {
  const g = (o: Partial<GoalEntry> & { text: string }): GoalEntry => ({
    status: 'pending',
    priority: 'medium',
    ...o,
  });

  test('add, status, notes, priority, complete, reopen, remove', () => {
    const prev = {
      active: [g({ text: 'A', id: 'a' }), g({ text: 'B', id: 'b' }), g({ text: 'R', id: 'r' })],
      completed: [g({ text: 'C', id: 'c', status: 'completed' })],
    };
    const next = {
      active: [
        g({ text: 'A', id: 'a', status: 'in_progress', notes: 'x', priority: 'high' }),
        g({ text: 'C', id: 'c' }),
        g({ text: 'N', id: 'n' }),
      ],
      completed: [g({ text: 'B', id: 'b', status: 'completed' })],
    };
    const ops = diffGoals(prev, next).map(
      (e) => `${e.op}:${e.goalId}:${e.from ?? ''}>${e.to ?? ''}`
    );
    expect(ops.sort()).toEqual(
      [
        'status:a:pending>in_progress',
        'notes:a:>x',
        'priority:a:medium>high',
        'reopen:c:completed>pending',
        'add:n:>pending',
        'complete:b:pending>completed',
        'remove:r:pending>',
      ].sort()
    );
  });

  test('a completed goal dropped by the 10-item cap is not a remove', () => {
    expect(
      diffGoals(
        { active: [], completed: [g({ text: 'Old', id: 'o', status: 'completed' })] },
        { active: [], completed: [] }
      )
    ).toEqual([]);
  });
});

describe('diffGoals subtasks', () => {
  test('a changed task list is one tasks event with done/total on each side', () => {
    const base = { status: 'pending', priority: 'medium', text: 'A', id: 'a' };
    const ops = diffGoals(
      { active: [{ ...base, tasks: [{ text: 'x', done: false }] }], completed: [] },
      {
        active: [
          {
            ...base,
            tasks: [
              { text: 'x', done: true },
              { text: 'y', done: false },
            ],
          },
        ],
        completed: [],
      }
    );
    expect(ops).toEqual([{ goalId: 'a', title: 'A', op: 'tasks', from: '0/1', to: '1/2' }]);
  });

  test('no tasks before and after is no event', () => {
    const base = { status: 'pending', priority: 'medium', text: 'A', id: 'a' };
    expect(diffGoals({ active: [base], completed: [] }, { active: [base], completed: [] })).toEqual(
      []
    );
  });
});

describe('diffGoals headline', () => {
  test('a changed headline is one headline event', () => {
    const base = { status: 'pending', priority: 'medium', text: 'A long brief', id: 'a' };
    const ops = diffGoals(
      { active: [base], completed: [] },
      { active: [{ ...base, headline: 'Short' }], completed: [] }
    );
    expect(ops).toEqual([{ goalId: 'a', title: 'A long brief', op: 'headline', to: 'Short' }]);
  });
});

describe('diffGoals renames', () => {
  test('a goal whose title changed under the same id is one title event', () => {
    const base = { status: 'pending', priority: 'medium' };
    const ops = diffGoals(
      { active: [{ ...base, text: 'Old', id: 'a' }], completed: [] },
      { active: [{ ...base, text: 'New', id: 'a' }], completed: [] }
    );
    expect(ops).toEqual([{ goalId: 'a', title: 'New', op: 'title', from: 'Old', to: 'New' }]);
  });
});

describe('writeGoalsFile', () => {
  test('first write assigns ids, stamps updated, logs adds with actor and cycle', () => {
    const backups: string[] = [];
    writeGoalsFile(path, '## Active Goals\n- [ ] Ship it\n  - status: pending\n', {
      actor: 'operator',
      cycleId: 'cyc-1',
      now: () => NOW,
      backup: (p) => backups.push(p),
    });
    const goal = read().active[0];
    expect(goal.id).toMatch(/^g-/);
    expect(goal.updated).toBe(NOW.toISOString());
    expect(backups).toEqual([path]);
    expect(events()).toEqual([
      {
        ts: NOW.toISOString(),
        goalId: goal.id as string,
        title: 'Ship it',
        op: 'add',
        to: 'pending',
        actor: 'operator',
        cycleId: 'cyc-1',
      },
    ]);
  });

  test('carries ids by title when a writer rebuilt goals without them, and stamps started once', () => {
    writeGoalsFile(path, '## Active Goals\n- [ ] Ship it\n  - status: pending\n', {
      actor: 'agent',
      now: () => NOW,
    });
    const id = read().active[0].id;
    const later = new Date('2026-10-06T16:00:00.000Z');
    writeGoalsFile(path, '## Active Goals\n- [ ] Ship it\n  - status: in_progress\n', {
      actor: 'strategist',
      now: () => later,
    });
    const g1 = read().active[0];
    expect(g1.id).toBe(id);
    expect(g1.started).toBe(later.toISOString());
    const last = events().at(-1);
    expect(last).toMatchObject({
      op: 'status',
      from: 'pending',
      to: 'in_progress',
      actor: 'strategist',
      goalId: id,
    });
    expect(last).not.toHaveProperty('cycleId');

    const third = new Date('2026-10-07T00:00:00.000Z');
    const cur = read();
    cur.active[0].status = 'blocked';
    writeGoalsFile(path, serializeGoals(cur.active, cur.completed), {
      actor: 'agent',
      now: () => third,
    });
    cur.active[0].status = 'in_progress';
    writeGoalsFile(path, serializeGoals(cur.active, cur.completed), {
      actor: 'agent',
      now: () => third,
    });
    expect(read().active[0].started).toBe(later.toISOString());
  });

  test('a legacy file without ids: a status change is one status event, not add + remove', () => {
    writeFileSync(
      path,
      '## Active Goals\n- [ ] Old goal\n  - status: pending\n  - priority: high\n'
    );
    writeGoalsFile(
      path,
      '## Active Goals\n- [ ] Old goal\n  - status: in_progress\n  - priority: high\n',
      {
        actor: 'agent',
        now: () => NOW,
      }
    );
    const evs = events();
    expect(evs.map((e) => e.op)).toEqual(['status']);
    expect(evs[0].goalId).toBe(read().active[0].id as string);
  });

  test('an unchanged write logs nothing and keeps updated', () => {
    writeGoalsFile(path, '## Active Goals\n- [ ] A\n', { actor: 'agent', now: () => NOW });
    const before = readFileSync(path, 'utf-8');
    writeGoalsFile(path, before, {
      actor: 'agent',
      now: () => new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(events()).toHaveLength(1);
  });

  test('accepts parsed goals and returns the written content', () => {
    const out = writeGoalsFile(
      path,
      { active: [{ text: 'X', status: 'pending', priority: 'low' }], completed: [] },
      { actor: 'wizard', now: () => NOW }
    );
    expect(out).toBe(readFileSync(path, 'utf-8'));
    expect(existsSync(join(dir, GOAL_EVENTS_FILE))).toBe(true);
  });

  test('a broken events file never stops the write, and bad lines are skipped on read', () => {
    writeFileSync(join(dir, GOAL_EVENTS_FILE), 'not json\n');
    writeGoalsFile(path, '## Active Goals\n- [ ] A\n', { actor: 'agent', now: () => NOW });
    expect(read().active).toHaveLength(1);
    expect(events()).toHaveLength(1);
  });
});

describe('writeGoalsFile duplicates', () => {
  test('two goals with the same title never share an id', () => {
    writeGoalsFile(path, '## Active Goals\n- [ ] Dup\n', { actor: 'agent', now: () => NOW });
    writeGoalsFile(path, '## Active Goals\n- [ ] Dup\n- [ ] Dup\n', {
      actor: 'agent',
      now: () => NOW,
    });
    const ids = read().active.map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
    expect(events().map((e) => e.op)).toEqual(['add', 'add']);
  });
});

describe('writeGoalsFile free-form content', () => {
  test('text with no goals in it is written verbatim, with no events', () => {
    writeGoalsFile(path, 'Keep going.', { actor: 'wizard', now: () => NOW });
    expect(readFileSync(path, 'utf-8')).toBe('Keep going.');
    expect(events()).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoalEvents } from '../../src/bot/goal-events';
import {
  TASKS_FILE,
  TASK_OPEN_CAP,
  TaskStore,
  readTasksSnapshot,
} from '../../src/goals/task-store';
import { parseGoals } from '../../src/tools/goals';

const NOW = new Date('2026-10-12T10:00:00.000Z');
let dir: string;
let clock: Date;

const GOALS = `## Active Goals
- [ ] Research dark factories
  - status: pending
  - priority: high
  - id: g-aaaaaaaa
- [ ] Write the newsletter
  - status: in_progress
  - priority: medium
  - id: g-bbbbbbbb

## Completed
- [x] Old goal
  - completed: 2026-10-01
  - id: g-cccccccc
`;

function store() {
  return new TaskStore(dir, { now: () => clock });
}
const goalsMd = () => readFileSync(join(dir, 'GOALS.md'), 'utf-8');
const taskEvents = () => readGoalEvents(dir).filter((e) => e.op.startsWith('task-'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task-store-'));
  writeFileSync(join(dir, 'GOALS.md'), GOALS, 'utf-8');
  clock = NOW;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function add(s: TaskStore, goalId: string, text: string, actor: 'operator' | 'agent' = 'operator') {
  const r = s.apply([{ op: 'add', goalId, text }], { actor });
  if (!r.ok) throw new Error(r.message);
  return r.results[0].id;
}

describe('TaskStore basics', () => {
  test('an empty store reads as rev 0 with no tasks and no file', () => {
    const s = store();
    expect(s.read()).toEqual({ version: 1, rev: 0, tasks: [] });
    expect(existsSync(join(dir, TASKS_FILE))).toBe(false);
  });

  test('add writes TASKS.json, bumps rev and stamps the task', () => {
    const s = store();
    const r = s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: '  Map L0-L4 \n levels ' }], {
      actor: 'agent',
      cycleId: 'c-1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rev).toBe(1);
    const id = r.results[0].id;
    expect(id).toMatch(/^t-[0-9a-f]{6}$/);
    const file = JSON.parse(readFileSync(join(dir, TASKS_FILE), 'utf-8'));
    expect(file.version).toBe(1);
    expect(file.rev).toBe(1);
    expect(file.tasks[0]).toEqual({
      id,
      goalId: 'g-aaaaaaaa',
      text: 'Map L0-L4 levels',
      lane: 'todo',
      order: 0,
      by: 'agent',
      createdAt: NOW.toISOString(),
      createdCycle: 'c-1',
      cycles: ['c-1'],
    });
  });

  test('add orders tasks within a goal', () => {
    const s = store();
    add(s, 'g-aaaaaaaa', 'one');
    add(s, 'g-aaaaaaaa', 'two');
    add(s, 'g-bbbbbbbb', 'other');
    const a = s.list().filter((t) => t.goalId === 'g-aaaaaaaa');
    expect(a.map((t) => [t.text, t.order])).toEqual([
      ['one', 0],
      ['two', 1],
    ]);
  });

  test('add dedupes against open tasks of the same goal and returns the existing id', () => {
    const s = store();
    const id = add(s, 'g-aaaaaaaa', 'Find three companies');
    const r = s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'find three companies!' }], {
      actor: 'agent',
    });
    expect(r.ok && r.results[0]).toEqual({ op: 'add', id, existing: true });
    expect(r.ok && r.rev).toBe(1);
    expect(s.list()).toHaveLength(1);
  });

  test('a done task with the same text does not dedupe', () => {
    const s = store();
    const id = add(s, 'g-aaaaaaaa', 'Find three companies');
    s.apply([{ op: 'move', id, lane: 'done' }], { actor: 'operator' });
    add(s, 'g-aaaaaaaa', 'Find three companies');
    expect(s.list()).toHaveLength(2);
  });

  test('add refuses an unknown or completed goal, empty and over-long text', () => {
    const s = store();
    const bad = (goalId: string, text: string) =>
      s.apply([{ op: 'add', goalId, text }], { actor: 'operator' });
    expect(bad('g-zzzzzzzz', 'x')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(bad('g-cccccccc', 'x')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(bad('g-aaaaaaaa', '   ')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(bad('g-aaaaaaaa', 'x'.repeat(201))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(s.read().rev).toBe(0);
  });

  test(`at most ${TASK_OPEN_CAP} open tasks per goal`, () => {
    const s = store();
    for (let i = 0; i < TASK_OPEN_CAP; i++)
      add(s, 'g-aaaaaaaa', `step number ${i} ${'abcdefghijkl'[i]}`);
    const r = s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'one more thing' }], {
      actor: 'operator',
    });
    expect(r).toMatchObject({ ok: false, reason: 'cap' });
    // Another goal is not affected.
    add(s, 'g-bbbbbbbb', 'fine');
  });

  test('expectedRev mismatch is a conflict and writes nothing', () => {
    const s = store();
    add(s, 'g-aaaaaaaa', 'one');
    const r = s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'two' }], {
      actor: 'operator',
      expectedRev: 0,
    });
    expect(r).toMatchObject({ ok: false, reason: 'conflict', rev: 1 });
    expect(s.list()).toHaveLength(1);
  });

  test('ops apply all or nothing', () => {
    const s = store();
    const id = add(s, 'g-aaaaaaaa', 'one');
    const r = s.apply(
      [
        { op: 'edit', id, text: 'renamed' },
        { op: 'move', id: 't-000000', lane: 'done' },
      ],
      { actor: 'operator' }
    );
    expect(r).toMatchObject({ ok: false, reason: 'not-found' });
    expect(s.get(id)?.text).toBe('one');
  });
});

describe('move, edit, note, remove, reorder', () => {
  test('move sets lane, doneAt, startedBy and records the cycle', () => {
    const s = store();
    const id = add(s, 'g-bbbbbbbb', 'draft');
    s.apply([{ op: 'move', id, lane: 'in_progress' }], { actor: 'agent', cycleId: 'c-2' });
    expect(s.get(id)).toMatchObject({
      lane: 'in_progress',
      startedBy: 'agent',
      startedAt: NOW.toISOString(),
      startedCycle: 'c-2',
      cycles: ['c-2'],
    });
    s.apply([{ op: 'move', id, lane: 'done', note: 'sent' }], { actor: 'operator' });
    expect(s.get(id)).toMatchObject({ lane: 'done', doneAt: NOW.toISOString(), note: 'sent' });
    s.apply([{ op: 'move', id, lane: 'todo' }], { actor: 'operator' });
    expect(s.get(id)?.doneAt).toBeUndefined();
  });

  test('a move into in_progress starts a To do goal in GOALS.md', () => {
    const s = store();
    const id = add(s, 'g-aaaaaaaa', 'map');
    s.apply([{ op: 'move', id, lane: 'in_progress' }], { actor: 'agent', cycleId: 'c-3' });
    const goal = parseGoals(goalsMd()).active.find((g) => g.id === 'g-aaaaaaaa');
    expect(goal?.status).toBe('in_progress');
    const ev = readGoalEvents(dir).find((e) => e.op === 'status');
    expect(ev).toMatchObject({ goalId: 'g-aaaaaaaa', actor: 'agent', cycleId: 'c-3' });
  });

  test('a blocked task leaves a To do goal alone', () => {
    const s = store();
    const id = add(s, 'g-aaaaaaaa', 'map');
    s.apply([{ op: 'move', id, lane: 'blocked' }], { actor: 'agent' });
    expect(parseGoals(goalsMd()).active[0].status).toBe('pending');
  });

  test('edit, note and remove', () => {
    const s = store();
    const id = add(s, 'g-aaaaaaaa', 'one');
    s.apply([{ op: 'edit', id, text: 'uno' }], { actor: 'operator' });
    s.apply([{ op: 'note', id, text: 'waiting on Ana' }], { actor: 'agent' });
    expect(s.get(id)).toMatchObject({ text: 'uno', note: 'waiting on Ana' });
    s.apply([{ op: 'note', id, text: '' }], { actor: 'agent' });
    expect(s.get(id)?.note).toBeUndefined();
    expect(s.apply([{ op: 'note', id, text: 'n'.repeat(201) }], { actor: 'agent' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    s.apply([{ op: 'remove', id }], { actor: 'operator' });
    expect(s.get(id)).toBeUndefined();
  });

  test('reorder puts the listed ids first, in order', () => {
    const s = store();
    const a = add(s, 'g-aaaaaaaa', 'alpha');
    const b = add(s, 'g-aaaaaaaa', 'bravo');
    const c = add(s, 'g-aaaaaaaa', 'charlie');
    s.apply([{ op: 'reorder', goalId: 'g-aaaaaaaa', ids: [c, a] }], { actor: 'operator' });
    expect(s.forGoal('g-aaaaaaaa').map((t) => t.id)).toEqual([c, a, b]);
    expect(
      s.apply([{ op: 'reorder', goalId: 'g-aaaaaaaa', ids: ['t-ffffff'] }], { actor: 'operator' })
    ).toMatchObject({ ok: false, reason: 'not-found' });
  });

  test('cycles keeps the last 10 distinct cycle ids', () => {
    const s = store();
    const id = add(s, 'g-aaaaaaaa', 'one');
    for (let i = 0; i < 12; i++)
      s.apply([{ op: 'note', id, text: `n${i}` }], { actor: 'agent', cycleId: `c-${i}` });
    expect(s.get(id)?.cycles).toEqual(Array.from({ length: 10 }, (_, i) => `c-${i + 2}`));
  });
});

describe('claims', () => {
  test('claim is a compare-and-swap: a live claim refuses a second one', () => {
    const s = store();
    const id = add(s, 'g-bbbbbbbb', 'draft');
    const r = s.apply([{ op: 'claim', id, runId: 'r-1', ttlMs: 60_000 }], { actor: 'system' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const token = r.results[0].token as string;
    expect(token).toBeTruthy();
    expect(s.get(id)).toMatchObject({
      lane: 'in_progress',
      startedBy: 'loop',
      claim: { runId: 'r-1', token, expiresAt: new Date(NOW.getTime() + 60_000).toISOString() },
    });
    expect(
      s.apply([{ op: 'claim', id, runId: 'r-2', ttlMs: 60_000 }], { actor: 'system' })
    ).toMatchObject({ ok: false, reason: 'claimed' });
  });

  test('an expired claim can be taken over', () => {
    const s = store();
    const id = add(s, 'g-bbbbbbbb', 'draft');
    s.apply([{ op: 'claim', id, runId: 'r-1', ttlMs: 1000 }], { actor: 'system' });
    clock = new Date(NOW.getTime() + 5000);
    const r = s.apply([{ op: 'claim', id, runId: 'r-2', ttlMs: 1000 }], { actor: 'system' });
    expect(r.ok).toBe(true);
    expect(s.get(id)?.claim?.runId).toBe('r-2');
  });

  test('while claimed only the holder or the operator may move or edit', () => {
    const s = store();
    const id = add(s, 'g-bbbbbbbb', 'draft');
    const r = s.apply([{ op: 'claim', id, runId: 'r-1', ttlMs: 60_000 }], { actor: 'system' });
    const token = r.ok ? (r.results[0].token as string) : '';
    expect(s.apply([{ op: 'move', id, lane: 'done' }], { actor: 'agent' })).toMatchObject({
      ok: false,
      reason: 'claimed',
    });
    expect(s.apply([{ op: 'edit', id, text: 'x' }], { actor: 'agent' })).toMatchObject({
      ok: false,
      reason: 'claimed',
    });
    expect(
      s.apply([{ op: 'note', id, text: 'step 1 done' }], { actor: 'agent', claimToken: token })
    ).toMatchObject({ ok: true });
    // The operator's edit keeps the claim.
    const e = s.apply([{ op: 'edit', id, text: 'draft v2' }], { actor: 'operator' });
    expect(e.ok && e.results[0].releasedClaim).toBeUndefined();
    expect(s.get(id)?.claim?.runId).toBe('r-1');
  });

  test('an operator move releases the claim and reports it', () => {
    const s = store();
    const id = add(s, 'g-bbbbbbbb', 'draft');
    s.apply([{ op: 'claim', id, runId: 'r-1', ttlMs: 60_000 }], { actor: 'system' });
    const r = s.apply([{ op: 'move', id, lane: 'todo' }], { actor: 'operator' });
    expect(r.ok && r.results[0].releasedClaim).toEqual({ runId: 'r-1' });
    expect(s.get(id)?.claim).toBeUndefined();
    expect(taskEvents().map((e) => e.op)).toContain('task-release');
  });

  test('an operator remove of a claimed task reports the released claim', () => {
    const s = store();
    const id = add(s, 'g-bbbbbbbb', 'draft');
    s.apply([{ op: 'claim', id, runId: 'r-9', ttlMs: 60_000 }], { actor: 'system' });
    const r = s.apply([{ op: 'remove', id }], { actor: 'operator' });
    expect(r.ok && r.results[0].releasedClaim).toEqual({ runId: 'r-9' });
  });

  test('renew extends, release clears and sets the lane; a wrong token is refused', () => {
    const s = store();
    const id = add(s, 'g-bbbbbbbb', 'draft');
    const r = s.apply([{ op: 'claim', id, runId: 'r-1', ttlMs: 1000 }], { actor: 'system' });
    const token = r.ok ? (r.results[0].token as string) : '';
    expect(
      s.apply([{ op: 'renew', id, token: 'nope', ttlMs: 1000 }], { actor: 'system' })
    ).toMatchObject({ ok: false, reason: 'claimed' });
    s.apply([{ op: 'renew', id, token, ttlMs: 10_000 }], { actor: 'system' });
    expect(s.get(id)?.claim?.expiresAt).toBe(new Date(NOW.getTime() + 10_000).toISOString());
    expect(
      s.apply([{ op: 'release', id, token: 'nope', lane: 'done' }], { actor: 'system' })
    ).toMatchObject({ ok: false, reason: 'claimed' });
    s.apply([{ op: 'release', id, token, lane: 'done', note: 'shipped' }], {
      actor: 'system',
      runId: 'r-1',
    });
    expect(s.get(id)).toMatchObject({ lane: 'done', note: 'shipped' });
    expect(s.get(id)?.claim).toBeUndefined();
  });
});

describe('task events', () => {
  test('every op appends a task-* row to goal-events.jsonl', () => {
    const s = store();
    const id = add(s, 'g-aaaaaaaa', 'map', 'agent');
    s.apply([{ op: 'move', id, lane: 'blocked', note: 'need access' }], {
      actor: 'agent',
      cycleId: 'c-1',
    });
    s.apply([{ op: 'edit', id, text: 'map it' }], { actor: 'operator' });
    s.apply([{ op: 'note', id, text: 'got it' }], { actor: 'operator' });
    s.apply([{ op: 'reorder', goalId: 'g-aaaaaaaa', ids: [id] }], { actor: 'operator' });
    s.apply([{ op: 'remove', id }], { actor: 'operator' });
    const evs = taskEvents();
    expect(evs.map((e) => e.op)).toEqual([
      'task-add',
      'task-move',
      'task-edit',
      'task-note',
      'task-reorder',
      'task-remove',
    ]);
    expect(evs[0]).toMatchObject({
      goalId: 'g-aaaaaaaa',
      title: 'Research dark factories',
      taskId: id,
      task: 'map',
      to: 'todo',
      actor: 'agent',
    });
    expect(evs[1]).toMatchObject({
      from: 'todo',
      to: 'blocked',
      note: 'need access',
      cycleId: 'c-1',
    });
  });

  test('claim and release rows carry the run id', () => {
    const s = store();
    const id = add(s, 'g-bbbbbbbb', 'draft');
    const r = s.apply([{ op: 'claim', id, runId: 'r-1', ttlMs: 1000 }], {
      actor: 'system',
      runId: 'r-1',
    });
    const token = r.ok ? (r.results[0].token as string) : '';
    s.apply([{ op: 'release', id, token, lane: 'todo' }], { actor: 'system', runId: 'r-1' });
    const evs = taskEvents().filter((e) => e.op !== 'task-add');
    expect(evs.map((e) => [e.op, e.runId])).toEqual([
      ['task-claim', 'r-1'],
      ['task-release', 'r-1'],
    ]);
  });
});

describe('orphans and backup', () => {
  test('listForGoals drops tasks whose goal is gone; completed goals keep theirs', () => {
    const s = store();
    add(s, 'g-aaaaaaaa', 'keep');
    // Complete the goal: tasks stay attached.
    writeFileSync(
      join(dir, 'GOALS.md'),
      GOALS.replace(
        '- [ ] Research dark factories\n  - status: pending\n  - priority: high\n  - id: g-aaaaaaaa\n',
        ''
      ).replace(
        '- [x] Old goal',
        '- [x] Research dark factories\n  - id: g-aaaaaaaa\n- [x] Old goal'
      ),
      'utf-8'
    );
    expect(s.listForGoals().map((t) => t.text)).toEqual(['keep']);
    writeFileSync(join(dir, 'GOALS.md'), '## Active Goals\n(no active goals)\n', 'utf-8');
    expect(s.listForGoals()).toEqual([]);
    expect(s.list()).toHaveLength(1);
  });

  test('backup is called with the TASKS.json path before an overwrite', () => {
    const seen: string[] = [];
    const s = new TaskStore(dir, { now: () => clock, backup: (p) => seen.push(p) });
    add(s, 'g-aaaaaaaa', 'one');
    add(s, 'g-aaaaaaaa', 'two');
    expect(seen).toEqual([join(dir, TASKS_FILE)]);
  });
});

describe('migration from GOALS.md task lines', () => {
  const LEGACY = `## Active Goals
- [ ] Research dark factories
  - status: pending
  - priority: high
  - task: [x] Map L0-L4 {id: t-aaaaaa, by: agent, cycle: c-1}
  - task: [~] Find 3 companies {id: t-bbbbbb, by: agent}
  - task: [!] Get approval {id: t-cccccc}
  - task: [ ] Send me a summary
  - id: g-aaaaaaaa

## Completed
(none yet)
`;

  test('the first load lifts task lines into TASKS.json and strips GOALS.md', () => {
    writeFileSync(join(dir, 'GOALS.md'), LEGACY, 'utf-8');
    const s = store();
    const tasks = s.list();
    expect(tasks.map((t) => [t.id.length, t.text, t.lane, t.by, t.createdCycle, t.order])).toEqual([
      [8, 'Map L0-L4', 'done', 'agent', 'c-1', 0],
      [8, 'Find 3 companies', 'in_progress', 'agent', undefined, 1],
      [8, 'Get approval', 'blocked', 'operator', undefined, 2],
      [8, 'Send me a summary', 'todo', 'operator', undefined, 3],
    ]);
    expect(tasks.slice(0, 3).map((t) => t.id)).toEqual(['t-aaaaaa', 't-bbbbbb', 't-cccccc']);
    expect(tasks.every((t) => t.goalId === 'g-aaaaaaaa')).toBe(true);
    expect(goalsMd()).not.toContain('- task:');
    expect(parseGoals(goalsMd()).active[0].id).toBe('g-aaaaaaaa');
    expect(existsSync(join(dir, TASKS_FILE))).toBe(true);
  });

  test('migration is idempotent', () => {
    writeFileSync(join(dir, 'GOALS.md'), LEGACY, 'utf-8');
    store().list();
    const once = readFileSync(join(dir, TASKS_FILE), 'utf-8');
    store().list();
    expect(readFileSync(join(dir, TASKS_FILE), 'utf-8')).toBe(once);
  });

  test('task lines that reappear (a restored GOALS.md) are lifted without duplicates', () => {
    writeFileSync(join(dir, 'GOALS.md'), LEGACY, 'utf-8');
    store().list();
    writeFileSync(join(dir, 'GOALS.md'), LEGACY, 'utf-8');
    const s = store();
    expect(s.list()).toHaveLength(4);
    expect(goalsMd()).not.toContain('- task:');
  });

  test('goals without ids get one before their tasks are lifted', () => {
    writeFileSync(
      join(dir, 'GOALS.md'),
      '## Active Goals\n- [ ] No id goal\n  - status: pending\n  - priority: medium\n  - task: [ ] Do it\n\n## Completed\n(none yet)\n',
      'utf-8'
    );
    const tasks = store().list();
    const goal = parseGoals(goalsMd()).active[0];
    expect(goal.id).toMatch(/^g-[0-9a-f]{8}$/);
    expect(tasks[0].goalId).toBe(goal.id);
    // Assigning ids is not a goal change: no add/remove events.
    expect(readGoalEvents(dir).filter((e) => e.op === 'add' || e.op === 'remove')).toEqual([]);
  });

  test('readTasksSnapshot reads legacy lines without writing anything', () => {
    writeFileSync(join(dir, 'GOALS.md'), LEGACY, 'utf-8');
    const snap = readTasksSnapshot(dir);
    expect(snap.rev).toBe(0);
    expect(snap.tasks.map((t) => t.text)).toEqual([
      'Map L0-L4',
      'Find 3 companies',
      'Get approval',
      'Send me a summary',
    ]);
    expect(existsSync(join(dir, TASKS_FILE))).toBe(false);
    expect(goalsMd()).toContain('- task:');
  });
});

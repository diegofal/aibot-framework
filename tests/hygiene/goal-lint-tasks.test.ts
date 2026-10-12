/**
 * goal-lint task findings (report-only, C22): stalled In progress, Blocked
 * without an ask, done without a note, orphan tasks.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { goalLint } from '../../src/hygiene/routines/goal-lint';
import type { WorkerRunView } from '../../src/workers/types';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';
import { NOW, makeCtx, makeDeps, writeFile } from './helpers';

let root: string;
let soulDir: string;
const H = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * H).toISOString();

beforeEach(() => {
  root = createTempDir('hygiene-goal-tasks');
  soulDir = join(root, 'soul');
  writeFile(
    join(soulDir, 'GOALS.md'),
    `## Active Goals
- [ ] Research dark factories
  - status: in_progress
  - id: g-aaaaaaaa

## Completed
- [x] Old goal
  - completed: 2026-08-01
  - id: g-cccccccc
`
  );
});
afterEach(() => removeTempDir(root));

type T = Record<string, unknown>;
function task(over: T): T {
  return {
    id: 't-000001',
    goalId: 'g-aaaaaaaa',
    text: 'A task',
    lane: 'todo',
    order: 0,
    by: 'agent',
    createdAt: iso(200),
    cycles: [],
    ...over,
  };
}
function tasks(list: T[]) {
  writeFile(join(soulDir, 'TASKS.json'), JSON.stringify({ version: 1, rev: 1, tasks: list }));
}
function events(rows: T[]) {
  writeFile(
    join(soulDir, 'goal-events.jsonl'),
    `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
  );
}
function cycles(hoursAgo: number[], status = 'completed') {
  const dir = join(root, 'data', 'agent-cycles', 'bot1');
  mkdirSync(dir, { recursive: true });
  hoursAgo.forEach((h, i) => {
    const startedAt = iso(h);
    appendFileSync(
      join(dir, `${startedAt.slice(0, 10)}.jsonl`),
      `${JSON.stringify({ cycleId: `c-${h}-${i}`, botId: 'bot1', startedAt, endedAt: startedAt, status })}\n`
    );
  });
}
const kinds = (deps = makeDeps()) =>
  goalLint
    .preview(makeCtx(root, { soulDir, deps }))
    .filter((f) => f.kind.startsWith('task-') || f.kind === 'orphan-task')
    .map((f) => [f.kind, f.data?.taskId]);

describe('task-stalled', () => {
  test('in progress, no run, no task event for 3 cycles', () => {
    tasks([task({ id: 't-000001', lane: 'in_progress', startedAt: iso(50) })]);
    events([
      {
        ts: iso(50),
        goalId: 'g-aaaaaaaa',
        title: '',
        op: 'task-move',
        taskId: 't-000001',
        to: 'in_progress',
        actor: 'agent',
      },
    ]);
    cycles([40, 30, 20]);
    expect(kinds()).toEqual([['task-stalled', 't-000001']]);
    const f = goalLint.preview(makeCtx(root, { soulDir })).find((x) => x.kind === 'task-stalled');
    expect(f).toMatchObject({ fixable: false, file: 'TASKS.json', severity: 'warn' });
    expect(f?.message).toContain('3 cycles');
  });

  test('two cycles, a skipped cycle, or a later task event are not enough', () => {
    tasks([task({ id: 't-000001', lane: 'in_progress', startedAt: iso(50) })]);
    events([
      {
        ts: iso(25),
        goalId: 'g-aaaaaaaa',
        title: '',
        op: 'task-note',
        taskId: 't-000001',
        actor: 'agent',
      },
    ]);
    cycles([40, 30, 20, 10]);
    cycles([5], 'skipped');
    expect(kinds()).toEqual([]);
  });

  test('a live claim or an active run counts as being worked on', () => {
    const claim = {
      runId: 'r-1',
      token: 'k',
      expiresAt: new Date(NOW.getTime() + H).toISOString(),
    };
    tasks([
      task({ id: 't-000001', lane: 'in_progress', startedAt: iso(50), claim }),
      task({ id: 't-000002', lane: 'in_progress', startedAt: iso(50) }),
    ]);
    cycles([40, 30, 20]);
    const runs = [{ runId: 'r-2', taskId: 't-000002', status: 'running' }] as WorkerRunView[];
    expect(kinds(makeDeps({ workerRuns: () => runs }))).toEqual([]);
  });
});

describe('task-blocked-no-ask', () => {
  test('blocked > 72 h with nothing pending', () => {
    tasks([task({ id: 't-000001', lane: 'blocked' })]);
    events([
      {
        ts: iso(80),
        goalId: 'g-aaaaaaaa',
        title: '',
        op: 'task-move',
        taskId: 't-000001',
        from: 'in_progress',
        to: 'blocked',
        actor: 'agent',
      },
    ]);
    expect(kinds()).toEqual([['task-blocked-no-ask', 't-000001']]);
  });

  test('blocked < 72 h, or with a run waiting on an ask, is fine', () => {
    tasks([task({ id: 't-000001', lane: 'blocked' }), task({ id: 't-000002', lane: 'blocked' })]);
    events([
      {
        ts: iso(10),
        goalId: 'g-aaaaaaaa',
        title: '',
        op: 'task-move',
        taskId: 't-000001',
        to: 'blocked',
        actor: 'agent',
      },
      {
        ts: iso(100),
        goalId: 'g-aaaaaaaa',
        title: '',
        op: 'task-move',
        taskId: 't-000002',
        to: 'blocked',
        actor: 'agent',
      },
    ]);
    const runs = [
      {
        runId: 'r-1',
        taskId: 't-000002',
        status: 'waiting',
        wait: { kind: 'ask', id: 'q', question: 'q', since: iso(90) },
      },
    ] as WorkerRunView[];
    expect(kinds(makeDeps({ workerRuns: () => runs }))).toEqual([]);
  });
});

describe('task-done-no-note and orphan-task', () => {
  test('done without a note is reported; with a note it is not', () => {
    tasks([
      task({ id: 't-000001', lane: 'done', doneAt: iso(5) }),
      task({ id: 't-000002', lane: 'done', doneAt: iso(5), note: 'Shipped: link' }),
    ]);
    expect(kinds()).toEqual([['task-done-no-note', 't-000001']]);
  });

  test('a task whose goal is not in GOALS.md is an orphan; a completed goal is not', () => {
    tasks([
      task({ id: 't-000001', goalId: 'g-dddddddd' }),
      task({ id: 't-000002', goalId: 'g-cccccccc', lane: 'done', note: 'ok' }),
    ]);
    expect(kinds()).toEqual([['orphan-task', 't-000001']]);
  });

  test('apply skips them (report-only) and never touches TASKS.json', () => {
    tasks([task({ id: 't-000001', goalId: 'g-dddddddd' })]);
    const before = readFileSync(join(soulDir, 'TASKS.json'), 'utf-8');
    const ctx = makeCtx(root, { soulDir });
    const res = goalLint.apply(ctx, goalLint.preview(ctx));
    expect(res.applied).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual(['not fixable']);
    expect(readFileSync(join(soulDir, 'TASKS.json'), 'utf-8')).toBe(before);
  });
});

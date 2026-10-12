import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type TaskChangeNotice,
  forwardTaskChanges,
  onTaskChanged,
} from '../../src/goals/task-events-bus';
import { TaskStore } from '../../src/goals/task-store';

const GOALS = `## Active Goals
- [ ] Research dark factories
  - status: pending
  - priority: high
  - id: g-aaaaaaaa
`;

let dir: string;
let seen: TaskChangeNotice[];
let off: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task-bus-'));
  writeFileSync(join(dir, 'GOALS.md'), GOALS, 'utf-8');
  seen = [];
  off = onTaskChanged((n) => seen.push(n));
});
afterEach(() => {
  off();
  rmSync(dir, { recursive: true, force: true });
});

describe('task change bus', () => {
  test('a successful apply publishes one notice per changed task with the new rev', () => {
    const s = new TaskStore(dir, { botId: 'bot-a' });
    const r = s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Find 3 companies' }], {
      actor: 'operator',
    });
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const n = seen[0];
    expect(n.botId).toBe('bot-a');
    expect(n.soulDir).toBe(dir);
    expect(n.data).toMatchObject({ goalId: 'g-aaaaaaaa', op: 'task-add', to: 'todo', rev: 1 });
    expect(n.data.taskId).toMatch(/^t-/);
  });

  test('moves carry from/to and the claim run id', () => {
    const s = new TaskStore(dir);
    const add = s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Task one' }], {
      actor: 'agent',
    });
    if (!add.ok) throw new Error('add failed');
    const id = add.results[0].id;
    seen.length = 0;
    s.apply([{ op: 'claim', id, runId: 'r-1', ttlMs: 60_000 }], { actor: 'system' });
    expect(seen[0].botId).toBeUndefined();
    expect(seen[0].data).toMatchObject({
      taskId: id,
      op: 'task-claim',
      from: 'todo',
      to: 'in_progress',
      runId: 'r-1',
      rev: 2,
    });
  });

  test('failed applies and no-op adds publish nothing', () => {
    const s = new TaskStore(dir);
    s.apply([{ op: 'move', id: 't-nope', lane: 'done' }], { actor: 'operator' });
    expect(seen).toHaveLength(0);
    s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Same task' }], { actor: 'agent' });
    seen.length = 0;
    s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Same task' }], { actor: 'agent' });
    expect(seen).toHaveLength(0);
  });

  test('a renew (heartbeat) publishes nothing', () => {
    const s = new TaskStore(dir);
    const add = s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Task one' }], {
      actor: 'agent',
    });
    if (!add.ok) throw new Error('add failed');
    const id = add.results[0].id;
    const claim = s.apply([{ op: 'claim', id, runId: 'r-1', ttlMs: 60_000 }], { actor: 'system' });
    if (!claim.ok) throw new Error('claim failed');
    seen.length = 0;
    s.apply([{ op: 'renew', id, token: claim.results[0].token as string, ttlMs: 60_000 }], {
      actor: 'system',
    });
    expect(seen).toHaveLength(0);
  });

  test('a throwing listener never breaks the write', () => {
    const offBad = onTaskChanged(() => {
      throw new Error('boom');
    });
    const s = new TaskStore(dir);
    const r = s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Still written' }], {
      actor: 'operator',
    });
    offBad();
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test('forwardTaskChanges publishes task:changed with the resolved bot id', () => {
    const published: Array<{ type: string; botId: string; data?: unknown }> = [];
    const stop = forwardTaskChanges({ publish: (e) => published.push(e) }, (soulDir) =>
      soulDir === dir ? 'bot-from-dir' : undefined
    );
    const s = new TaskStore(dir);
    s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Forwarded' }], { actor: 'operator' });
    new TaskStore(join(dir, 'other')).apply([], { actor: 'operator' });
    stop();
    s.apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'After stop, different' }], {
      actor: 'operator',
    });
    expect(published).toHaveLength(1);
    expect(published[0].type).toBe('task:changed');
    expect(published[0].botId).toBe('bot-from-dir');
    expect((published[0].data as { op: string }).op).toBe('task-add');
  });

  test('forwardTaskChanges drops notices whose bot cannot be resolved', () => {
    const published: unknown[] = [];
    const stop = forwardTaskChanges({ publish: (e) => published.push(e) }, () => undefined);
    new TaskStore(dir).apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Orphan' }], {
      actor: 'operator',
    });
    stop();
    expect(published).toHaveLength(0);
  });
});

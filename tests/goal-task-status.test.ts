import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulLoader } from '../src/soul';
import {
  createGoalsTool,
  ensureGoalIds,
  parseGoals,
  serializeGoals,
  taskStatus,
} from '../src/tools/goals';

const logger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
} as any;

function loader(content: string | null) {
  let stored = content;
  return {
    readGoals: () => stored,
    writeGoals: (c: string) => {
      stored = c;
    },
    get content() {
      return stored;
    },
  };
}

const md = `## Active Goals
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

describe('task status, author and id', () => {
  test('parse reads the status mark and the {id, by, cycle} suffix', () => {
    expect(parseGoals(md).active[0].tasks).toEqual([
      {
        text: 'Map L0-L4',
        done: true,
        status: 'done',
        id: 't-aaaaaa',
        by: 'agent',
        cycleId: 'c-1',
      },
      { text: 'Find 3 companies', done: false, status: 'in_progress', id: 't-bbbbbb', by: 'agent' },
      { text: 'Get approval', done: false, status: 'blocked', id: 't-cccccc' },
      { text: 'Send me a summary', done: false, status: 'todo' },
    ]);
  });

  test('braces that are not a known suffix stay in the text', () => {
    const one = md.replace('Send me a summary', 'Use {curly} words {not: meta}');
    expect(parseGoals(one).active[0].tasks?.[3].text).toBe('Use {curly} words {not: meta}');
  });

  test('serialize round-trips status and suffix', () => {
    const { active, completed } = parseGoals(md);
    const out = serializeGoals(active, completed);
    expect(out).toContain('  - task: [~] Find 3 companies {id: t-bbbbbb, by: agent}');
    expect(out).toContain('  - task: [!] Get approval {id: t-cccccc}');
    expect(out).toContain('  - task: [ ] Send me a summary\n');
    expect(parseGoals(out).active[0].tasks).toEqual(active[0].tasks);
  });

  test('a task without status falls back to done', () => {
    expect(taskStatus({ text: 'a', done: true })).toBe('done');
    expect(taskStatus({ text: 'a', done: false })).toBe('todo');
    expect(taskStatus({ text: 'a', done: false, status: 'blocked' })).toBe('blocked');
  });

  test('ensureGoalIds gives every task an id', () => {
    const { active, completed } = parseGoals(md);
    ensureGoalIds(active, completed);
    const ids = active[0].tasks?.map((t) => t.id) ?? [];
    expect(ids.slice(0, 3)).toEqual(['t-aaaaaa', 't-bbbbbb', 't-cccccc']);
    expect(ids[3]).toMatch(/^t-[0-9a-f]{6}$/);
  });
});

describe('manage_goals task actions (task store)', () => {
  let dir: string;
  let soul: SoulLoader;
  const tool = () => createGoalsTool(() => soul);
  const run = (args: Record<string, unknown>) => tool().execute({ _botId: 'b', ...args }, logger);
  const store = () => soul.getTaskStore();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goal-task-tool-'));
    writeFileSync(join(dir, 'GOALS.md'), md, 'utf-8');
    soul = new SoulLoader(
      { enabled: true, dir, versioning: { enabled: false, maxVersionsPerFile: 10 } } as any,
      logger
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('the legacy task lines are migrated on first use', async () => {
    await run({ action: 'list' });
    expect(readFileSync(join(dir, 'GOALS.md'), 'utf-8')).not.toContain('- task:');
    expect(store().list()).toHaveLength(4);
  });

  test('add_task adds a task by the agent with its cycle', async () => {
    const res = await run({
      action: 'add_task',
      goal: 'dark factories',
      task: 'Compare what they automated first',
      _cycleId: 'c-9',
    });
    expect(res.success).toBe(true);
    const t = store().list().at(-1);
    expect(t).toMatchObject({
      goalId: 'g-aaaaaaaa',
      text: 'Compare what they automated first',
      lane: 'todo',
      by: 'agent',
      createdCycle: 'c-9',
    });
    expect(res.content).toContain(t?.id as string);
    expect(readFileSync(join(dir, 'GOALS.md'), 'utf-8')).not.toContain('Compare what');
  });

  test('add_task of a near-duplicate returns the existing task', async () => {
    const res = await run({ action: 'add_task', goal: 'dark factories', task: 'find 3 companies' });
    expect(res.success).toBe(true);
    expect(res.content).toContain('t-bbbbbb');
    expect(res.content.toLowerCase()).toContain('already');
    expect(store().list()).toHaveLength(4);
  });

  test('add_task with lane in_progress starts the goal and marks the agent as starter', async () => {
    await run({ action: 'add_task', goal: 'dark factories', task: 'Go', lane: 'in_progress' });
    expect(parseGoals(readFileSync(join(dir, 'GOALS.md'), 'utf-8')).active[0].status).toBe(
      'in_progress'
    );
    expect(store().list().at(-1)).toMatchObject({ lane: 'in_progress', startedBy: 'agent' });
  });

  test('update_task moves a task by id alone, or by text within a goal', async () => {
    const a = await run({
      action: 'update_task',
      task: 't-bbbbbb',
      status: 'done',
      _cycleId: 'c-2',
    });
    expect(a.success).toBe(true);
    const b = await run({
      action: 'update_task',
      goal: 'dark factories',
      task: 'summary',
      lane: 'blocked',
      note: 'waiting on the operator',
    });
    expect(b.success).toBe(true);
    const byId = Object.fromEntries(
      store()
        .list()
        .map((t) => [t.text, t])
    );
    expect(byId['Find 3 companies']).toMatchObject({ lane: 'done', cycles: ['c-2'] });
    expect(byId['Send me a summary']).toMatchObject({
      lane: 'blocked',
      note: 'waiting on the operator',
    });
  });

  test('update_task to in_progress records the agent as starter; pending means todo', async () => {
    await run({ action: 'update_task', task: 't-cccccc', status: 'in_progress' });
    expect(store().get('t-cccccc')).toMatchObject({ lane: 'in_progress', startedBy: 'agent' });
    await run({ action: 'update_task', task: 't-cccccc', status: 'pending' });
    expect(store().get('t-cccccc')?.lane).toBe('todo');
  });

  test('update_task by text without a goal works when the text is unique', async () => {
    const res = await run({ action: 'update_task', task: 'approval', status: 'done' });
    expect(res.success).toBe(true);
    expect(store().get('t-cccccc')?.lane).toBe('done');
  });

  test('update_task reports an unknown task with the list', async () => {
    const res = await run({
      action: 'update_task',
      goal: 'dark factories',
      task: 'nope nope',
      status: 'done',
    });
    expect(res.success).toBe(false);
    expect(res.content).toContain('t-aaaaaa');
  });

  test('a bad lane is refused', async () => {
    const res = await run({ action: 'update_task', task: 't-aaaaaa', status: 'later' });
    expect(res.success).toBe(false);
  });

  test('note_task leaves a note without moving the task', async () => {
    const res = await run({ action: 'note_task', task: 't-bbbbbb', note: 'two found so far' });
    expect(res.success).toBe(true);
    expect(store().get('t-bbbbbb')).toMatchObject({
      lane: 'in_progress',
      note: 'two found so far',
    });
    const missing = await run({ action: 'note_task', task: 't-bbbbbb' });
    expect(missing.success).toBe(false);
  });

  test('a task claimed by a worker run is refused to the agent', async () => {
    store().apply([{ op: 'claim', id: 't-cccccc', runId: 'r-1', ttlMs: 60_000 }], {
      actor: 'system',
    });
    const res = await run({ action: 'update_task', task: 't-cccccc', status: 'done' });
    expect(res.success).toBe(false);
    expect(res.content).toContain('r-1');
  });

  test('list shows goals with their open tasks', async () => {
    const res = await run({ action: 'list' });
    expect(res.content).toContain('[g-aaaaaaaa] Research dark factories');
    expect(res.content).toContain('[~] t-bbbbbb Find 3 companies');
    expect(res.content).toContain('+1 done');
  });
});

import { describe, expect, mock, test } from 'bun:test';
import {
  createGoalsTool,
  editGoal,
  ensureGoalIds,
  mergeTasks,
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

describe('mergeTasks', () => {
  const existing = parseGoals(md).active[0].tasks ?? [];

  test('known ids keep their author and cycle; status comes from the edit', () => {
    const out = mergeTasks(
      existing,
      [{ text: 'Map L0-L4', done: false, status: 'blocked', id: 't-aaaaaa', by: 'operator' }],
      'operator'
    );
    expect(out).toEqual([
      {
        text: 'Map L0-L4',
        done: false,
        status: 'blocked',
        id: 't-aaaaaa',
        by: 'agent',
        cycleId: 'c-1',
      },
    ]);
  });

  test('new tasks are stamped with the author; done follows status', () => {
    const out = mergeTasks(existing, [{ text: 'New one', done: true }], 'operator');
    expect(out).toEqual([{ text: 'New one', done: true, status: 'done', by: 'operator' }]);
  });
});

describe('editGoal nudges a To do goal when one of its tasks starts', () => {
  test('a task in progress moves a pending goal to in_progress', () => {
    const tasks = parseGoals(md).active[0].tasks ?? [];
    const out = editGoal(md.replace('[~]', '[ ]').replace('[x]', '[ ]'), 'g-aaaaaaaa', {
      tasks,
    }) as string;
    const g = parseGoals(out).active[0];
    expect(g.status).toBe('in_progress');
    expect(g.started).toBeTruthy();
  });

  test('only blocked or todo tasks leave the goal where it is', () => {
    const tasks = [{ text: 'x', done: false, status: 'blocked' as const }];
    const out = editGoal(md, 'g-aaaaaaaa', { tasks }) as string;
    expect(parseGoals(out).active[0].status).toBe('pending');
  });
});

describe('manage_goals add_task / update_task', () => {
  test('add_task appends a task by the agent with its cycle', async () => {
    const l = loader(md);
    const tool = createGoalsTool(() => l as any);
    const res = await tool.execute(
      {
        action: 'add_task',
        goal: 'dark factories',
        task: 'Compare what they automated first',
        _botId: 'b',
        _cycleId: 'c-9',
      },
      logger
    );
    expect(res.success).toBe(true);
    const t = parseGoals(l.content).active[0].tasks?.at(-1);
    expect(t).toMatchObject({
      text: 'Compare what they automated first',
      status: 'todo',
      by: 'agent',
      cycleId: 'c-9',
    });
    expect(res.content).toContain(t?.id as string);
  });

  test('add_task with status in_progress starts the goal', async () => {
    const l = loader(md);
    const tool = createGoalsTool(() => l as any);
    await tool.execute(
      {
        action: 'add_task',
        goal: 'dark factories',
        task: 'Go',
        status: 'in_progress',
        _botId: 'b',
      },
      logger
    );
    expect(parseGoals(l.content).active[0].status).toBe('in_progress');
  });

  test('update_task moves a task by id or by text', async () => {
    const l = loader(md);
    const tool = createGoalsTool(() => l as any);
    const a = await tool.execute(
      {
        action: 'update_task',
        goal: 'dark factories',
        task: 't-bbbbbb',
        status: 'done',
        _botId: 'b',
      },
      logger
    );
    expect(a.success).toBe(true);
    const b = await tool.execute(
      {
        action: 'update_task',
        goal: 'dark factories',
        task: 'summary',
        status: 'blocked',
        _botId: 'b',
      },
      logger
    );
    expect(b.success).toBe(true);
    const tasks = parseGoals(l.content).active[0].tasks ?? [];
    expect(tasks.map((t) => t.status)).toEqual(['done', 'done', 'blocked', 'blocked']);
    expect(tasks[1].done).toBe(true);
  });

  test('update_task reports an unknown task with the list', async () => {
    const l = loader(md);
    const tool = createGoalsTool(() => l as any);
    const res = await tool.execute(
      {
        action: 'update_task',
        goal: 'dark factories',
        task: 'nope nope',
        status: 'done',
        _botId: 'b',
      },
      logger
    );
    expect(res.success).toBe(false);
    expect(res.content).toContain('t-aaaaaa');
  });

  test('a bad status is refused', async () => {
    const l = loader(md);
    const tool = createGoalsTool(() => l as any);
    const res = await tool.execute(
      {
        action: 'update_task',
        goal: 'dark factories',
        task: 't-aaaaaa',
        status: 'later',
        _botId: 'b',
      },
      logger
    );
    expect(res.success).toBe(false);
  });
});

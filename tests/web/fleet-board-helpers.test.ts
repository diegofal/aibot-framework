import { describe, expect, it } from 'bun:test';
import {
  BOARD_COLUMNS,
  addTask,
  boardColumns,
  boardFilterCounts,
  boardLane,
  filterLanes,
  goalCard,
  goalRef,
  lastCycle,
  moveTask,
  removeTask,
  renameTask,
  taskProgress,
  toggleTask,
} from '../../web/pages/fleet-board-helpers.js';

const t = (text: string, done = false) => ({ text, done });
const goal = (over: Record<string, unknown> = {}) => ({
  id: 'g-11111111',
  text: 'Write the Monday brief',
  status: 'in_progress',
  priority: 'high',
  notes: null,
  source: 'operator',
  section: 'active',
  tasks: [t('Pick sources', true), t('Draft 600 words')],
  ...over,
});

describe('subtask list operations (pure, never mutate)', () => {
  const list = [t('a'), t('b', true), t('c')];

  it('toggle flips one task', () => {
    const next = toggleTask(list, 0);
    expect(next.map((x) => x.done)).toEqual([true, true, false]);
    expect(list[0].done).toBe(false);
    expect(toggleTask(list, 9)).toBe(list);
  });

  it('add trims, ignores blanks and multi-line input becomes one line', () => {
    expect(addTask(list, '  d  ').at(-1)).toEqual(t('d'));
    expect(addTask(list, '   ')).toBe(list);
    expect(addTask(list, 'x\ny').at(-1)).toEqual(t('x y'));
  });

  it('rename keeps done; blank rename removes nothing', () => {
    expect(renameTask(list, 1, ' B ')[1]).toEqual(t('B', true));
    expect(renameTask(list, 1, ' ')).toBe(list);
  });

  it('remove and move', () => {
    expect(removeTask(list, 1).map((x) => x.text)).toEqual(['a', 'c']);
    expect(moveTask(list, 2, -1).map((x) => x.text)).toEqual(['a', 'c', 'b']);
    expect(moveTask(list, 0, -1)).toBe(list);
  });

  it('progress counts done over total', () => {
    expect(taskProgress(list)).toEqual({ done: 1, total: 3, pct: 33 });
    expect(taskProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
    expect(taskProgress(undefined)).toEqual({ done: 0, total: 0, pct: 0 });
  });
});

describe('boardColumns / lastCycle', () => {
  const home = {
    goals: {
      todo: [goal({ id: 'g-a', status: 'pending' })],
      inProgress: [goal()],
      blocked: [],
      active: [],
      completedRecently: Array.from({ length: 9 }, (_, i) =>
        goal({ id: `g-d${i}`, section: 'completed', status: 'completed' })
      ),
    },
    timeline: [
      { ts: '2026-10-10T10:00:00Z', kind: 'cycle', title: 'Cycle 3', detail: 'older plan' },
      { ts: '2026-10-10T11:00:00Z', kind: 'tool', title: 'web_fetch', detail: 'x' },
      { ts: '2026-10-10T12:00:00Z', kind: 'cycle', title: 'Cycle 4', detail: 'Draft the brief' },
    ],
  };

  it('splits into the four board columns, done capped at the latest five', () => {
    const cols = boardColumns(home);
    expect(Object.keys(cols)).toEqual(BOARD_COLUMNS.map((c) => c.id));
    expect(cols.todo).toHaveLength(1);
    expect(cols.inProgress).toHaveLength(1);
    expect(cols.done).toHaveLength(5);
    expect(boardColumns(null)).toEqual({ todo: [], inProgress: [], blocked: [], done: [] });
  });

  it('lastCycle is the newest cycle row', () => {
    expect(lastCycle(home)).toEqual({ ts: '2026-10-10T12:00:00Z', summary: 'Draft the brief' });
    expect(lastCycle({ timeline: [] })).toBeNull();
  });
});

describe('goalCard', () => {
  it('shows title, priority, operator badge, progress and every subtask with its index', () => {
    const html = goalCard('b1', goal(), 'inProgress');
    expect(html).toContain('Write the Monday brief');
    expect(html).toContain('data-goal="g-11111111"');
    expect(html).toContain('data-bot="b1"');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('1/2');
    expect(html).toContain('data-task="0"');
    expect(html).toContain('data-task="1"');
    expect(html).toContain('checked');
    expect(html).toContain('you');
    expect(html).toContain('data-action="add-task"');
  });

  it('escapes user text and uses the title as ref when a goal has no id', () => {
    const html = goalCard('b1', goal({ id: null, text: '<b>x</b>', tasks: [t('<i>')] }), 'todo');
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('data-goal="&lt;b&gt;x&lt;/b&gt;"');
    expect(goalRef(goal({ id: null, text: 'T' }))).toEqual({ goal: 'T' });
    expect(goalRef(goal())).toEqual({ id: 'g-11111111' });
  });

  it('done cards are not draggable and have no add-task box', () => {
    const html = goalCard('b1', goal({ section: 'completed', status: 'completed' }), 'done');
    expect(html).not.toContain('draggable="true"');
    expect(html).not.toContain('data-action="add-task"');
  });
});

describe('boardLane', () => {
  const agent = { id: 'b1', name: 'Bot One', running: true, enabled: true };
  const presence = {
    nowLine: 'I am executing my plan.',
    tone: 'active',
    isExecuting: true,
    running: true,
    enabled: true,
    currentTool: 'web_fetch',
    pendingAsks: 1,
    unreviewed: 2,
    posture: 'active',
  };
  const home = {
    goals: { todo: [], inProgress: [goal()], blocked: [], active: [], completedRecently: [] },
    timeline: [{ ts: '2026-10-10T12:00:00Z', kind: 'cycle', title: 'C', detail: 'Draft it' }],
  };

  it('header says what the agent is doing and offers its controls; four columns follow', () => {
    const html = boardLane(agent, presence, home, Date.parse('2026-10-10T12:30:00Z'));
    expect(html).toContain('Bot One');
    expect(html).toContain('I am executing my plan.');
    expect(html).toContain('web_fetch');
    expect(html).toContain('Draft it');
    expect(html).toContain('1 ask');
    expect(html).toContain('2 to review');
    expect(html).toContain('data-quick="run"');
    for (const c of BOARD_COLUMNS) expect(html).toContain(`data-col="${c.id}"`);
    expect(html).toContain('data-action="add-goal"');
  });

  it('a lane whose goals did not load says so instead of looking empty', () => {
    expect(boardLane(agent, presence, null)).toContain('Could not load goals');
  });
});

describe('lane filters', () => {
  const lanes = [
    { agent: { id: 'a' }, presence: { isExecuting: true, pendingAsks: 0, unreviewed: 0 } },
    { agent: { id: 'b' }, presence: { isExecuting: false, pendingAsks: 2, unreviewed: 0 } },
    { agent: { id: 'c' }, presence: { isExecuting: false, pendingAsks: 0, unreviewed: 0 } },
  ];
  it('working / needs you / all', () => {
    expect(filterLanes(lanes, 'working').map((l) => l.agent.id)).toEqual(['a']);
    expect(filterLanes(lanes, 'needs').map((l) => l.agent.id)).toEqual(['b']);
    expect(filterLanes(lanes, 'all')).toHaveLength(3);
    expect(boardFilterCounts(lanes)).toEqual({ all: 3, working: 1, needs: 1 });
  });
});

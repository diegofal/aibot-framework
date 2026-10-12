import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INLINE_TASKS_SHOWN,
  boardHtml,
  cardHtml,
  drawerHtml,
  goalKindPayload,
  inlineTasks,
} from '../../web/pages/fleet-board-helpers.js';
import { activeWorkersByTask } from '../../web/pages/workers-helpers.js';

const task = (id: string, text: string, lane: string, over: Record<string, unknown> = {}) => ({
  id,
  text,
  lane,
  status: lane,
  done: lane === 'done',
  by: 'agent',
  note: null,
  cycleId: null,
  ...over,
});
const goal = (over: Record<string, unknown> = {}) => ({
  id: 'g-1',
  text: 'Research dark factories',
  status: 'in_progress',
  priority: 'high',
  source: 'agent',
  section: 'active',
  tasks: [
    task('t-1', 'Map L0-L4', 'done'),
    task('t-2', 'Send me a summary', 'todo'),
    task('t-3', 'Get <approval>', 'blocked'),
    task('t-4', 'Find companies', 'in_progress'),
  ],
  ...over,
});
const NOW = Date.parse('2026-10-12T10:00:00Z');
const rows = (html: string) => [...html.matchAll(/class="fb-itask [^"]*" data-task-id="([^"]+)"/g)];

describe('inline tasks on a board card', () => {
  it('lists open tasks: in progress, then blocked, then to do; done ones are not listed', () => {
    const html = cardHtml(goal(), false, { nowMs: NOW });
    expect(rows(html).map((m) => m[1])).toEqual(['t-4', 't-3', 't-2']);
    expect(html).not.toContain('data-task-id="t-1"');
    // The mini bar still counts the done one.
    expect(html).toContain('1/4');
    expect(html).toContain('Get &lt;approval&gt;');
  });

  it('tints each row by lane', () => {
    const html = cardHtml(goal(), false, { nowMs: NOW });
    expect(html).toContain('class="fb-itask ip" data-task-id="t-4"');
    expect(html).toContain('class="fb-itask bl" data-task-id="t-3"');
    expect(html).toContain('class="fb-itask td" data-task-id="t-2"');
  });

  it('reads tasks written before lanes from status / done', () => {
    const old = goal({
      tasks: [
        { id: 't-a', text: 'A', done: true },
        { id: 't-b', text: 'B', done: false },
        { id: 't-c', text: 'C', done: false, status: 'in_progress' },
      ],
    });
    expect(inlineTasks(old.tasks).map((r: { task: { id: string } }) => r.task.id)).toEqual([
      't-c',
      't-b',
    ]);
  });

  it('caps the list at five rows and says how many more', () => {
    const many = Array.from({ length: 8 }, (_, i) => task(`t-${i}`, `Task ${i}`, 'todo'));
    const html = cardHtml(goal({ tasks: many }), false, { nowMs: NOW });
    expect(INLINE_TASKS_SHOWN).toBe(5);
    expect(rows(html)).toHaveLength(5);
    expect(html).toContain('data-imore');
    expect(html).toContain('+3 more');
    expect(cardHtml(goal(), false, { nowMs: NOW })).not.toContain('data-imore');
  });

  it('task controls carry what the wiring needs: task id, index in goal.tasks, toggle, text', () => {
    const html = cardHtml(goal(), false, { nowMs: NOW });
    const row = html.slice(html.indexOf('data-task-id="t-3"'));
    expect(row.slice(0, 300)).toContain('data-ti="2"');
    expect(html).toContain('data-itoggle');
    expect(html).toContain('class="fb-itask-t"');
    expect(html).toContain('data-iadd');
    expect(html).toContain('+ task');
  });

  it('a goal with no open tasks still offers "+ task" and lists nothing', () => {
    const html = cardHtml(goal({ tasks: [task('t-1', 'x', 'done')] }), false, { nowMs: NOW });
    expect(rows(html)).toHaveLength(0);
    expect(html).toContain('data-iadd');
    expect(html).not.toContain('fb-itasks');
  });

  it('a worker on a task shows a compact pulsing badge that opens the worker', () => {
    const workers = activeWorkersByTask([
      {
        runId: 'r-1',
        taskId: 't-4',
        status: 'running',
        step: 3,
        budget: { steps: 8 },
        currentTool: 'web_fetch',
        startedAt: '2026-10-12T09:54:00Z',
      },
    ]);
    const html = cardHtml(goal(), false, { nowMs: NOW, workers });
    const row = html.slice(html.indexOf('data-task-id="t-4"'), html.indexOf('data-task-id="t-3"'));
    expect(row).toContain('data-open-worker="r-1"');
    expect(row).toContain('wk-pulse');
    expect(row).toContain('step 3/8');
    expect(row).toContain('web_fetch');
    expect(html.slice(html.indexOf('data-task-id="t-3"'))).not.toContain('data-open-worker');
  });

  it('a waiting worker is amber', () => {
    const workers = activeWorkersByTask([
      { runId: 'r-2', taskId: 't-4', status: 'waiting', question: 'Which one?' },
    ]);
    const html = cardHtml(goal(), false, { nowMs: NOW, workers });
    expect(html).toContain('is-wait');
    expect(html).toContain('waiting on you');
  });

  it('a claimed task without run data still shows the worker badge', () => {
    const claimed = goal({
      tasks: [task('t-9', 'Claimed', 'in_progress', { claim: { runId: 'r-9' } })],
    });
    const html = cardHtml(claimed, false, { nowMs: NOW });
    expect(html).toContain('data-open-worker="r-9"');
    expect(html).toContain('wk-pulse');
  });

  it('a standing goal shows a "standing" tag and no task list', () => {
    const html = cardHtml(goal({ kind: 'standing', tasks: [] }), false, { nowMs: NOW });
    expect(html).toContain('fb-tag standing');
    expect(html).not.toContain('fb-itasks');
    expect(html).not.toContain('data-iadd');
  });

  it('done cards stay a single line with no tasks', () => {
    const html = cardHtml(goal({ section: 'completed', status: 'completed' }), false);
    expect(html).not.toContain('fb-itask');
    expect(html).not.toContain('data-iadd');
  });
});

describe('the drawer: standing / project, and history', () => {
  it('a project offers "Mark standing"; a standing goal offers "Make it a project"', () => {
    const agent = { id: 'b1', name: 'Bot' };
    const project = drawerHtml(agent, goal());
    expect(project).toContain('data-kind="standing"');
    expect(project).toContain('Mark standing');
    const standing = drawerHtml(agent, goal({ kind: 'standing', tasks: [] }));
    expect(standing).toContain('data-kind=""');
    expect(standing).toContain('Make it a project');
    expect(standing).not.toContain('id="fb-addtask"');
  });

  it('has a History button', () => {
    expect(drawerHtml({ id: 'b1' }, goal())).toContain('data-history');
  });

  it('goalKindPayload builds the PATCH body (by id, else by text)', () => {
    expect(goalKindPayload({ id: 'g-1', text: 'x' }, 'standing')).toEqual({
      id: 'g-1',
      kind: 'standing',
    });
    expect(goalKindPayload({ text: 'x' }, '')).toEqual({ goal: 'x', kind: '' });
    expect(goalKindPayload({ id: 'g-1' }, 'other')).toBeNull();
  });
});

describe('boardHtml: one board for the Fleet Board and Agent Home', () => {
  const home = {
    goals: {
      inProgress: [goal()],
      todo: [goal({ id: 'g-2', status: 'pending', text: 'Next' })],
      blocked: [],
      completedRecently: [],
      tasksRev: 4,
    },
  };

  it('renders the four columns for one agent, with the add-goal input and its id', () => {
    const html = boardHtml(home, { botId: 'b 1', nowMs: NOW });
    expect(html).toContain('class="fb-board no-blocked" data-bot="b 1"');
    for (const c of ['inProgress', 'todo', 'blocked', 'done'])
      expect(html).toContain(`data-col="${c}"`);
    expect(html).toContain('data-addgoal');
    expect(html).toContain('data-task-id="t-4"');
  });

  it('marks the selected card', () => {
    expect(boardHtml(home, { botId: 'b1', selectedRef: 'g-2' })).toContain('fb-card high sel');
  });

  it('Agent Home mounts the shared board, not its own', () => {
    const src = readFileSync(join(import.meta.dir, '../../web/pages/agent-home.js'), 'utf8');
    expect(src.includes('boardHtml')).toBe(true);
    expect(src.includes('mountGoalBoard')).toBe(true);
    expect(src.includes('goalsColumns')).toBe(false);
    const fleet = readFileSync(join(import.meta.dir, '../../web/pages/fleet-board.js'), 'utf8');
    expect(fleet.includes('mountGoalBoard')).toBe(true);
  });
});

import { describe, expect, it } from 'bun:test';
import {
  ago,
  goalAddForm,
  goalFormPayload,
  goalMovePayload,
  goalsColumns,
  groupTimelineByCycle,
  groupTimelineByHour,
  homeTabs,
  hourLabel,
  isTaskConflict,
  karmaBody,
  karmaTone,
  needsYouStrip,
  taskAddRequest,
  taskMoveRequest,
  timelineBody,
  timelineRow,
  traitAxes,
  traitsBody,
} from '../../web/pages/agent-home-helpers.js';

// Fixed "now": 2026-09-13 15:30 local time.
const NOW = new Date(2026, 8, 13, 15, 30).getTime();
const at = (h: number, m = 0, dayOffset = 0) =>
  new Date(2026, 8, 13 + dayOffset, h, m).toISOString();

describe('hourLabel / groupTimelineByHour', () => {
  it('labels today, yesterday and older days', () => {
    expect(hourLabel(at(14, 12), NOW)).toBe('Today 14:00');
    expect(hourLabel(at(9, 0, -1), NOW)).toBe('Yesterday 09:00');
    expect(hourLabel(at(8, 0, -5), NOW)).toMatch(/· 08:00$/);
    expect(hourLabel('garbage', NOW)).toBe('Unknown time');
  });
  it('groups consecutive items by hour and keeps order', () => {
    const items = [
      { ts: at(14, 50), kind: 'llm', title: 'a' },
      { ts: at(14, 10), kind: 'tool', title: 'b' },
      { ts: at(13, 59), kind: 'tool', title: 'c' },
    ];
    const groups = groupTimelineByHour(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today 14:00', 'Today 13:00']);
    expect(groups[0].items.map((i) => i.title)).toEqual(['a', 'b']);
    expect(groupTimelineByHour(undefined, NOW)).toEqual([]);
  });
});

describe('timelineRow / timelineBody', () => {
  it('renders kind badge, time, escaped title and failure state', () => {
    const html = timelineRow({
      ts: at(14, 5),
      kind: 'tool',
      title: '<exec>',
      detail: 'x&y',
      ok: false,
    });
    expect(html).toContain('home-tl-row home-tl-failed');
    expect(html).toContain('>14:05<');
    expect(html).toContain('ui-badge-danger">tool<');
    expect(html).toContain('&lt;exec&gt;');
    expect(html).toContain('x&amp;y');
  });
  it('falls back to cycle for an unknown kind and omits empty detail', () => {
    const html = timelineRow({ ts: at(14, 5), kind: 'weird', title: 't', detail: null, ok: null });
    expect(html).toContain('>cycle<');
    expect(html).not.toContain('home-tl-detail');
  });
  it('renders an empty state or grouped rows', () => {
    expect(timelineBody([], NOW)).toContain('Nothing happened yet');
    const html = timelineBody([{ ts: at(14, 5), kind: 'llm', title: 'call' }], NOW);
    expect(html).toContain('home-tl-group-label">Today 14:00<');
    expect(html).toContain('>call<');
  });
});

describe('timeline grouped by cycle (Why row 6)', () => {
  const cycleWhy = {
    what: 'Agent-loop cycle',
    by: 'agent',
    cycle: { id: 'c1', botId: 'b1', plan: 'Draft the digest' },
    goal: { id: 'g1', title: 'Weekly digest' },
  };
  const items = [
    { ts: at(14, 50), kind: 'cycle', title: 'Cycle · completed', cycleId: 'c1', why: cycleWhy },
    { ts: at(14, 45), kind: 'tool', title: 'file_write', cycleId: 'c1' },
    { ts: at(14, 44), kind: 'karma', title: 'Karma +3' },
    { ts: at(14, 40), kind: 'llm', title: 'planner', cycleId: 'c1' },
    { ts: at(14, 30), kind: 'tool', title: 'web_search', cycleId: 'c2' },
  ];

  it('collects every row of a cycle where its newest row is; others stay loose', () => {
    const entries = groupTimelineByCycle(items);
    expect(entries.map((e) => e.cycleId ?? e.item.title)).toEqual(['c1', 'Karma +3', 'c2']);
    expect(entries[0].head.title).toBe('Cycle · completed');
    expect(entries[0].items.map((i) => i.title)).toEqual(['file_write', 'planner']);
    expect(entries[2].head).toBeNull();
    expect(entries[2].items.map((i) => i.title)).toEqual(['web_search']);
    expect(groupTimelineByCycle(undefined)).toEqual([]);
  });

  it('renders one Why per cycle group, with its rows inside', () => {
    const html = timelineBody(items, NOW);
    expect(html.match(/<details class="why">/g)).toHaveLength(1);
    expect(html.match(/home-tl-cycle"/g)).toHaveLength(2);
    expect(html).toContain('data-open-cycle="c1"');
    expect(html).toContain('Weekly digest');
    const c1 = html.slice(html.indexOf('home-tl-cycle"'), html.indexOf('Karma +3'));
    expect(c1).toContain('file_write');
    expect(c1).toContain('planner');
    expect(html).toContain('Cycle with no record yet');
  });
});

describe('goalsColumns (board)', () => {
  it('shows an empty state without goals', () => {
    expect(goalsColumns({ active: [], blocked: [], completedRecently: [] })).toContain(
      'No goals yet'
    );
    expect(goalsColumns(undefined)).toContain('No goals yet');
  });
  it('falls back to splitting active by status when todo/inProgress are missing', () => {
    const html = goalsColumns({
      active: [
        { text: 'A', status: 'pending' },
        { text: 'B', status: 'in_progress' },
      ],
      blocked: [],
      completedRecently: [],
    });
    const cells = html.split('class="home-board-cell"').slice(1);
    expect(cells[0]).toContain('>A<');
    expect(cells[1]).toContain('>B<');
  });
});

const board = (over = {}) => ({
  todo: [],
  inProgress: [],
  blocked: [],
  completedRecently: [],
  ...over,
});
const research = {
  id: 'g-1',
  text: 'Research dark factories',
  priority: 'high',
  status: 'in_progress',
  source: 'agent',
  tasks: [
    { id: 't-1', text: 'Map L0-L4', done: true, status: 'done', by: 'agent', cycleId: 'c-1' },
    { id: 't-2', text: 'Find <3> companies', done: false, status: 'in_progress', by: 'agent' },
    { id: 't-3', text: 'Get approval', done: false, status: 'blocked' },
    { id: 't-4', text: 'Send me a summary', done: false, status: 'todo', by: 'operator' },
  ],
};

describe('goal board rows (tasks open under the clicked card)', () => {
  it('lays cards out row by row: row r holds the r-th goal of every column', () => {
    const html = goalsColumns(
      board({ todo: [{ text: 'T1' }, { text: 'T2' }], inProgress: [{ text: 'P1' }] })
    );
    const order = ['T1', 'P1', 'T2'].map((t) => html.indexOf(`>${t}<`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // 4 heads + 2 rows × 4 cells + 4 foot cells
    expect(html.match(/class="home-board-cell[ "]/g)).toHaveLength(16);
  });

  it('puts the add-goal form at the bottom of To do, after every card', () => {
    const html = goalsColumns(board({ todo: [{ text: 'T1' }, { text: 'T2' }] }));
    expect(html.indexOf('id="home-goal-form"')).toBeGreaterThan(html.indexOf('>T2<'));
  });

  it('cards show priority (medium too), who set the goal, and a task bar', () => {
    const html = goalsColumns(
      board({
        todo: [{ text: 'Mid', priority: 'medium', source: 'operator' }],
        inProgress: [research],
      })
    );
    expect(html).toContain('pri-medium">medium<');
    expect(html).toContain('home-goal-you');
    expect(html).toContain('home-goal-agent');
    expect(html).toContain('1/4 tasks done');
    expect(html).toContain('1 blocked');
    expect(html).toContain('No tasks yet');
    expect(html.match(/class="home-task-seg /g)).toHaveLength(4);
    expect(html).not.toContain('home-goal-move');
  });

  it('each goal gets a stable colour', () => {
    const a = goalsColumns(board({ inProgress: [research] }));
    const b = goalsColumns(board({ inProgress: [research], todo: [{ text: 'Other' }] }));
    const color = (h) => h.match(/data-goal-id="g-1"[^>]*--goal-color:(#[0-9a-f]{6})/)?.[1];
    expect(color(a)).toMatch(/^#[0-9a-f]{6}$/);
    expect(color(a)).toBe(color(b));
  });

  it('no panel until a goal is selected', () => {
    expect(goalsColumns(board({ inProgress: [research] }))).not.toContain('home-goal-panel');
  });

  it('the selected goal opens its tasks right after its own row, pointing at its column', () => {
    const html = goalsColumns(
      board({
        todo: [{ text: 'T1' }, { text: 'T2' }],
        inProgress: [{ text: 'P1' }, research],
      }),
      { selectedId: 'g-1', botId: 'b1' }
    );
    const panel = html.indexOf('class="home-goal-panel"');
    expect(panel).toBeGreaterThan(html.indexOf('>T2<'));
    expect(panel).toBeLessThan(html.indexOf('id="home-goal-form"'));
    expect(html).toContain('--col:1');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/home-goal-card is-selected/);
  });

  it('the panel has four task lanes with the tasks in them, escaped', () => {
    const html = goalsColumns(board({ inProgress: [research] }), {
      selectedId: 'g-1',
      botId: 'b1',
    });
    for (const s of ['todo', 'in_progress', 'blocked', 'done'])
      expect(html).toContain(`data-task-status="${s}"`);
    expect(html).toContain('Find &lt;3&gt; companies');
    expect(html).toContain('data-task-id="t-2"');
    expect(html).toContain('data-add-task');
    expect(html).toContain('data-goal-history');
    expect(html).toContain('data-goal-close');
  });

  it('task cards say who made them and link the cycle that did', () => {
    const html = goalsColumns(board({ inProgress: [research] }), {
      selectedId: 'g-1',
      botId: 'b1',
    });
    expect(html).toContain('data-open-cycle="c-1" data-bot-id="b1"');
    const mine = html.slice(html.indexOf('data-task-id="t-4"'));
    expect(mine.slice(0, 400)).toContain('home-goal-you');
  });

  it('offers to complete the goal when every task is done', () => {
    const allDone = {
      ...research,
      tasks: research.tasks.map((t) => ({ ...t, done: true, status: 'done' })),
    };
    const html = goalsColumns(board({ inProgress: [allDone] }), { selectedId: 'g-1' });
    expect(html).toContain('All tasks done');
    expect(html).toContain('data-complete-goal');
  });

  it('the panel status control moves the goal and shows its column', () => {
    const html = goalsColumns(board({ inProgress: [research] }), { selectedId: 'g-1' });
    expect(html).toMatch(/class="home-goal-status[^"]*"[^>]*>/);
    expect(html).toMatch(/<option value="in_progress" selected>/);
  });

  it('a selected goal that is gone shows no panel', () => {
    const html = goalsColumns(board({ todo: [{ text: 'A', id: 'g-x' }] }), { selectedId: 'g-1' });
    expect(html).not.toContain('home-goal-panel');
  });
});

describe('isTaskConflict', () => {
  it('is true for a 409 body (stale rev or a claimed task), false otherwise', () => {
    expect(isTaskConflict({ error: 'x', reason: 'conflict', rev: 3 })).toBe(true);
    expect(isTaskConflict({ error: 'x', reason: 'claimed', rev: 3 })).toBe(true);
    expect(isTaskConflict({ error: 'x', reason: 'invalid', rev: 3 })).toBe(false);
    expect(isTaskConflict({ rev: 3 })).toBe(false);
    expect(isTaskConflict(null)).toBe(false);
  });
});

describe('task op requests (task store endpoints)', () => {
  it('taskMoveRequest PATCHes one task with its lane and the board rev', () => {
    expect(taskMoveRequest('b 1', research, 't-4', 'in_progress', 7)).toEqual({
      method: 'PATCH',
      path: '/api/agents/b%201/tasks/t-4',
      body: { lane: 'in_progress', expectedRev: 7 },
    });
    expect(taskMoveRequest('b1', research, 't-4', 'todo', 7)).toBeNull();
    expect(taskMoveRequest('b1', research, 't-nope', 'done', 7)).toBeNull();
    expect(taskMoveRequest('b1', research, 't-1', 'later', 7)).toBeNull();
  });

  it('taskMoveRequest leaves expectedRev out when the board has none', () => {
    expect(taskMoveRequest('b1', research, 't-4', 'done')?.body).toEqual({ lane: 'done' });
  });

  it('taskAddRequest POSTs one line to the goal (by id, else by title), or null when empty', () => {
    expect(taskAddRequest('b1', research, '  Call\nthem ')).toEqual({
      method: 'POST',
      path: '/api/agents/b1/goals/g-1/tasks',
      body: { text: 'Call them' },
    });
    expect(taskAddRequest('b1', research, '   ')).toBeNull();
    expect(taskAddRequest('b1', { text: 'No id goal' }, 'First')?.path).toBe(
      '/api/agents/b1/goals/No%20id%20goal/tasks'
    );
  });
});

describe('goalMovePayload', () => {
  it('builds the PATCH body, or null for an unknown status', () => {
    expect(goalMovePayload('Ship', 'done')).toEqual({ goal: 'Ship', status: 'done' });
    expect(goalMovePayload('Ship', 'paused')).toBeNull();
    expect(goalMovePayload('', 'done')).toBeNull();
  });
});

describe('operator goals on the board', () => {
  it('marks goals the operator set with a "you" badge', () => {
    const html = goalsColumns({
      active: [
        { text: 'Mine', source: 'operator' },
        { text: 'Its own', source: 'agent' },
      ],
      blocked: [],
      completedRecently: [],
    });
    expect(html.match(/home-goal-you/g)).toHaveLength(1);
    expect(html.indexOf('home-goal-you')).toBeLessThan(html.indexOf('Its own'));
  });

  it('empty state tells the operator to add a goal here', () => {
    expect(goalsColumns(undefined)).toContain('Add one in To do');
  });

  it('renders the add form with a title input and priority select', () => {
    const html = goalAddForm();
    expect(html).toContain('id="home-goal-form"');
    expect(html).toContain('name="title"');
    expect(html).toContain('maxlength="200"');
    expect(html).toContain('<option value="medium" selected>');
  });

  it('builds the POST body from the form values, or null when empty', () => {
    expect(goalFormPayload('  Ship it ', 'high')).toEqual({ title: 'Ship it', priority: 'high' });
    expect(goalFormPayload('Ship it', '')).toEqual({ title: 'Ship it', priority: 'medium' });
    expect(goalFormPayload('   ', 'high')).toBeNull();
    expect(goalFormPayload(undefined, undefined)).toBeNull();
  });
});

describe('traitAxes / karmaTone', () => {
  it('turns a traits record into sorted radar axes', () => {
    expect(traitAxes({ warmth: 0.7, assertiveness: '0.3', bad: 'x' })).toEqual([
      { label: 'assertiveness', value: 0.3 },
      { label: 'warmth', value: 0.7 },
    ]);
    expect(traitAxes(null)).toEqual([]);
  });
  it('maps scores to tones', () => {
    expect(karmaTone(85)).toBe('ok');
    expect(karmaTone(55)).toBe('warn');
    expect(karmaTone(10)).toBe('danger');
    expect(karmaTone(null)).toBe('muted');
  });
});

describe('needsYouStrip', () => {
  it('is empty when nothing is pending', () => {
    expect(needsYouStrip({ asks: 0, permissions: 0, productionsPending: 0 }, 'b1')).toBe('');
    expect(needsYouStrip(undefined, 'b1')).toBe('');
  });
  it('renders one chip per pending kind with singular/plural and links', () => {
    const html = needsYouStrip({ asks: 1, permissions: 2, productionsPending: 3 }, 'b 1');
    expect(html).toContain('href="#/needs/inbox">1 question to answer<');
    expect(html).toContain('href="#/needs/permissions">2 permissions to decide<');
    expect(html).toContain('href="#/work/productions/b%201">3 outputs to review<');
  });
});

describe('homeTabs', () => {
  it('links the five tabs and marks the active one', () => {
    const html = homeTabs('b1', 'config');
    expect(html).toContain('href="#/agents/b1">Home<');
    expect(html).toContain('class="ui-tab active" href="#/agents/b1/config"');
    expect(html).toContain('href="#/insights/stats/bot/b1">Stats<');
    expect(html).toContain('href="#/work/productions/b1">Productions<');
    expect(html).toContain('href="#/work/conversations/b1">Conversations<');
  });
});

describe('ago', () => {
  it('formats relative past times', () => {
    expect(ago(NOW - 10_000, NOW)).toBe('just now');
    expect(ago(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(ago(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h ago');
    expect(ago(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
    expect(ago('nope', NOW)).toBe('');
  });
});

describe('traitsBody', () => {
  it('shows an empty state under three traits', () => {
    expect(traitsBody({ current: { a: 0.5 } })).toContain('No trait registers yet');
    expect(traitsBody(null)).toContain('No trait registers yet');
  });
  it('renders a radar and the drift note', () => {
    const html = traitsBody({
      current: { warmth: 0.7, rigor: 0.4, humor: 0.5 },
      drift: { warmth: 0.12, rigor: -0.01 },
      adjustments: 4,
    });
    expect(html).toContain('<svg class="ui-radar');
    expect(html).toContain('4 adjustments · drift: warmth +0.12');
    expect(html).not.toContain('rigor -0.01');
    expect(traitsBody({ current: { a: 0.5, b: 0.5, c: 0.5 } })).toContain('stable since baseline');
  });
});

describe('karmaBody', () => {
  it('renders the score tile, sparkline and a hint without events', () => {
    const html = karmaBody(
      { score: 72, trend: 'rising', delta7d: 3, history: [{ score: 69 }, { score: 72 }] },
      NOW
    );
    expect(html).toContain('ui-kpi ui-kpi-ok');
    expect(html).toContain('ui-kpi-value">72<');
    expect(html).toContain('ui-kpi-delta-ok">+3<');
    expect(html).toContain('rising · 7d');
    expect(html).toContain('<polyline');
    expect(html).toContain('No karma events yet');
  });
  it('lists recent events with sign, source and age, escaping text', () => {
    const html = karmaBody(
      {
        score: 30,
        recentEvents: [{ ts: NOW - 60_000 * 5, delta: -1, reason: '<bad>', source: 'tool' }],
      },
      NOW
    );
    expect(html).toContain('ui-kpi-danger');
    expect(html).toContain('>-1<');
    expect(html).toContain('ui-badge-muted">tool<');
    expect(html).toContain('&lt;bad&gt;');
    expect(html).toContain('5m ago');
  });
});

describe('goals board drag and drop', () => {
  it('cards are draggable and columns carry the status a drop moves to', () => {
    const html = goalsColumns({
      todo: [{ text: 'Drag me' }],
      inProgress: [],
      blocked: [],
      completedRecently: [],
    });
    expect(html).toContain('draggable="true"');
    for (const s of ['pending', 'in_progress', 'blocked', 'done'])
      expect(html).toContain(`data-status="${s}"`);
  });
});

describe('goal board — live workers (C20)', () => {
  const NOW_W = Date.parse('2026-10-12T10:00:00Z');
  const worker = {
    runId: 'r-1',
    taskId: 't-2',
    status: 'running',
    step: 3,
    budget: { steps: 8, toolCalls: 40, wallMs: 3_600_000 },
    used: { steps: 3, toolCalls: 7, wallMs: 1 },
    currentTool: 'web_fetch',
    startedAt: '2026-10-12T09:54:00Z',
  };

  it('the task a worker runs carries its badge; other tasks do not', () => {
    const html = goalsColumns(board({ inProgress: [research] }), {
      selectedId: 'g-1',
      botId: 'b1',
      workers: [worker],
      nowMs: NOW_W,
    });
    const card = html.split('data-task-id="t-2"')[1].split('home-task-card')[0];
    expect(card).toContain('data-open-worker="r-1"');
    expect(card).toContain('step 3/8');
    expect(html.split('data-task-id="t-4"')[1].split('home-task-card')[0]).not.toContain(
      'data-open-worker'
    );
  });

  it('a goal card pulses while a worker runs one of its tasks', () => {
    const html = goalsColumns(board({ inProgress: [research] }), {
      botId: 'b1',
      workers: [worker],
    });
    expect(html).toContain('home-goal-working');
    expect(goalsColumns(board({ inProgress: [research] }), { botId: 'b1' })).not.toContain(
      'home-goal-working'
    );
  });
});

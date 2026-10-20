import { describe, expect, it } from 'bun:test';
import {
  BOARD_COLUMNS,
  activityCycles,
  activityHtml,
  addTask,
  agentLine,
  agentPanel,
  boardColumns,
  cardHtml,
  drawerHtml,
  filterLanes,
  fleetPulse,
  goalHeadline,
  goalPulse,
  goalRef,
  goalYardstickMs,
  lastCycle,
  moveTask,
  needsByBot,
  removeTask,
  renameTask,
  spawnedHtml,
  stateLine,
  taskAddRequest,
  taskProgress,
  taskRemoveRequest,
  taskRenameRequest,
  taskReorderRequest,
  taskToggleRequest,
  toggleTask,
} from '../../web/pages/fleet-board-helpers.js';

const t = (text: string, done = false) => ({ text, done });
const goal = (over: Record<string, unknown> = {}) => ({
  id: 'g-11111111',
  text: 'Maintain a living FDE skills map (one production file, fde-skills-map.md): evals, retrieval/RAG, agents and tool use',
  status: 'in_progress',
  priority: 'high',
  notes: null,
  source: 'operator:2026-10-04',
  section: 'active',
  headline: null,
  tasks: [t('Pick sources', true), t('Draft 600 words')],
  ...over,
});
const home = (goals: Record<string, unknown>[] = [goal()]) => ({
  goals: {
    todo: goals.filter((g) => g.status === 'pending'),
    inProgress: goals.filter((g) => g.status === 'in_progress'),
    blocked: goals.filter((g) => g.status === 'blocked'),
    active: [],
    completedRecently: goals.filter((g) => g.section === 'completed'),
  },
  timeline: [{ ts: '2026-10-10T12:00:00Z', kind: 'cycle', title: 'C', detail: 'Draft it' }],
});
const NOW = Date.parse('2026-10-10T12:30:00Z');

describe('subtask list operations (pure, never mutate)', () => {
  const list = [t('a'), t('b', true), t('c')];
  it('toggle, add, rename, remove, move', () => {
    expect(toggleTask(list, 0).map((x) => x.done)).toEqual([true, true, false]);
    expect(list[0].done).toBe(false);
    expect(toggleTask(list, 9)).toBe(list);
    expect(addTask(list, ' x\ny ').at(-1)).toEqual(t('x y'));
    expect(addTask(list, '  ')).toBe(list);
    expect(renameTask(list, 1, ' B ')[1]).toEqual(t('B', true));
    expect(renameTask(list, 1, ' ')).toBe(list);
    expect(removeTask(list, 1).map((x) => x.text)).toEqual(['a', 'c']);
    expect(moveTask(list, 2, -1).map((x) => x.text)).toEqual(['a', 'c', 'b']);
    expect(moveTask(list, 0, -1)).toBe(list);
  });
  it('progress', () => {
    expect(taskProgress(list)).toEqual({ done: 1, total: 3, pct: 33 });
    expect(taskProgress(undefined)).toEqual({ done: 0, total: 0, pct: 0 });
  });
});

describe('goalHeadline: a short card title from a long brief', () => {
  const h = (text: string, headline: string | null = null) => goalHeadline({ text, headline });
  it('a set headline wins', () => {
    expect(h('anything long', 'Short')).toEqual({ head: 'Short', tag: null });
  });
  it('cuts at the earliest clause break', () => {
    expect(h(goal().text as string).head).toBe('Maintain a living FDE skills map');
    expect(h('Weekly roles brief every Monday: 5 live AI engineer roles').head).toBe(
      'Weekly roles brief every Monday'
    );
    expect(h('Relevar el perfil: restricciones, comensales').head).toBe('Relevar el perfil');
  });
  it('"Live up to my purpose:" becomes "Purpose: …" up to the first sentence', () => {
    expect(h('Live up to my purpose: We want to become a dark factory. research more').head).toBe(
      'Purpose: We want to become a dark factory'
    );
  });
  it('a leading all-caps tag becomes a tag; an all-caps opening is sentence-cased', () => {
    expect(h('DORMIDO — Gatillo: cuando Diego (o cualquier persona) me cuente algo')).toEqual({
      head: 'Cuando Diego (o cualquier persona) me cuente algo',
      tag: 'dormant',
    });
    expect(h('CONTROL ÚNICO DE CICLO, cuatro chequeos en el punto de acción: uno').head).toBe(
      'Control único de ciclo, cuatro chequeos en el punto de acción'
    );
  });
  it('never splits inside quotes and caps long text at a word with an ellipsis', () => {
    expect(h('Entregar cada cambio al plan con "Chequeado contra: x" y una nota').head).toBe(
      'Entregar cada cambio al plan con "Chequeado contra: x" y una nota'
    );
    // A one-sentence goal up to 140 chars is shown whole, not cut at 72.
    expect(
      h(
        'Every day, come up with a different potential idea that can make me a billionaire eventually'
      ).head
    ).toBe(
      'Every day, come up with a different potential idea that can make me a billionaire eventually'
    );
    const long = h(`${'word '.repeat(40)}end`).head;
    expect(long.length).toBeLessThanOrEqual(141);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('stateLine: plain-language status', () => {
  it('working, waiting, stopped, disabled, idle', () => {
    expect(stateLine({ isExecuting: true, currentTool: 'web_fetch', running: true }, NOW)).toEqual({
      text: 'Working · web_fetch',
      tone: 'live',
    });
    expect(stateLine({ running: true, pendingAsks: 2 }, NOW)).toEqual({
      text: 'Waiting on you · 2 questions',
      tone: 'wait',
    });
    expect(stateLine({ running: false, enabled: true }, NOW).text).toBe('Stopped');
    expect(stateLine({ running: false, enabled: false }, NOW).text).toBe('Disabled');
    const idle = stateLine(
      { running: true, nextRunAt: new Date(NOW + 3 * 3_600_000).toISOString() },
      NOW
    );
    expect(idle.tone).toBe('idle');
    expect(idle.text).toContain('Idle');
    expect(idle.text).toContain('3h');
  });
});

describe('data shaping', () => {
  it('columns in board order, done capped at 8', () => {
    expect(BOARD_COLUMNS.map((c) => c.id)).toEqual(['inProgress', 'todo', 'blocked', 'done']);
    const many = Array.from({ length: 12 }, (_, i) =>
      goal({ id: `d${i}`, section: 'completed', status: 'completed' })
    );
    expect(boardColumns(home(many)).done).toHaveLength(8);
    expect(boardColumns(null)).toEqual({ inProgress: [], todo: [], blocked: [], done: [] });
  });
  it('goalRef, lastCycle', () => {
    expect(goalRef(goal())).toEqual({ id: 'g-11111111' });
    expect(goalRef(goal({ id: null, text: 'T' }))).toEqual({ goal: 'T' });
    expect(lastCycle(home())).toEqual({ ts: '2026-10-10T12:00:00Z', summary: 'Draft it' });
  });
  it('pulse and filters', () => {
    const lanes = [
      { agent: { id: 'a', name: 'Alpha' }, presence: { isExecuting: true }, home: home() },
      {
        agent: { id: 'b', name: 'Beta' },
        presence: { pendingAsks: 1, unreviewed: 2 },
        home: home([]),
      },
    ];
    expect(fleetPulse(lanes)).toEqual({ agents: 2, working: 1, waiting: 3, openGoals: 1 });
    expect(filterLanes(lanes, 'live', '').map((l) => l.agent.id)).toEqual(['a']);
    expect(filterLanes(lanes, 'needs', '').map((l) => l.agent.id)).toEqual(['b']);
    expect(filterLanes(lanes, 'all', 'skills map').map((l) => l.agent.id)).toEqual(['a']);
    expect(filterLanes(lanes, 'all', 'beta').map((l) => l.agent.id)).toEqual(['b']);
  });
});

/** A link inside a link is invalid HTML: the browser splits the outer one (the 10 Oct board bug). */
function nestedAnchor(html: string): boolean {
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)a[\s>]/g)) {
    depth += m[1] ? -1 : 1;
    if (depth > 1) return true;
  }
  return false;
}

describe('markup', () => {
  const lane = {
    agent: { id: 'b1', name: 'Bot One', running: true, enabled: true },
    presence: { running: true, enabled: true, pendingAsks: 1, unreviewed: 2, posture: 'active' },
    home: home([goal(), goal({ id: 'g-2', status: 'pending', text: 'Next thing to do: soon' })]),
  };
  const needs = [
    { kind: 'ask', title: 'Which stack are you on?', href: '#/needs/inbox/b1/c1' },
    { kind: 'production', title: '04_brief.md', href: '#/work/productions/b1?file=04_brief.md' },
  ];

  it('needsByBot groups Needs You items per agent', () => {
    const g = needsByBot([
      { botId: 'a', kind: 'ask', title: 'q' },
      { botId: 'b', kind: 'production', title: 'f' },
      { botId: 'a', kind: 'permission', title: 'p' },
    ]);
    expect(g.a.map((x: { title: string }) => x.title)).toEqual(['q', 'p']);
    expect(needsByBot(null)).toEqual({});
  });

  it('collapsed line: one compact line, focus headline, counts, waiting count, no nested links', () => {
    const html = agentLine(lane, needs, { nowMs: NOW, expanded: false });
    expect(html).toContain('Bot One');
    expect(html).toContain('Waiting on you · 1 question');
    expect(html).toContain('Maintain a living FDE skills map');
    expect(html).not.toContain('evals, retrieval');
    expect(html).toContain('2 goals');
    // Subtasks summed over the open goals: 1/2 + 1/2.
    expect(html).toContain('2/4');
    expect(html).toContain('2 waiting');
    expect(html).toContain('data-toggle="b1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('fb-panel');
    expect(nestedAnchor(html)).toBe(false);
  });

  it('expanded line adds the panel: what it is doing, what it waits on (real titles), goals', () => {
    const html = agentLine(lane, needs, { nowMs: NOW, expanded: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('fb-panel');
    expect(html).toContain('Draft it');
    expect(html).toContain('Which stack are you on?');
    expect(html).toContain('04_brief.md');
    expect(html).toContain('href="#/needs/inbox/b1/c1"');
    for (const c of BOARD_COLUMNS) expect(html).toContain(`data-col="${c.id}"`);
    expect(html).toContain('data-addgoal');
    expect(html).toContain('data-quick="run"');
    expect(nestedAnchor(html)).toBe(false);
  });

  it('panel says when nothing waits on you, and when goals failed to load', () => {
    const quiet = { ...lane, presence: { ...lane.presence, pendingAsks: 0, unreviewed: 0 } };
    expect(agentPanel(quiet, [], { nowMs: NOW })).toContain('Nothing waiting on you');
    expect(agentPanel(lane, [], { nowMs: NOW })).toContain('3 items in Needs you');
    expect(agentPanel({ ...lane, home: null }, [], { nowMs: NOW })).toContain(
      'Could not load goals'
    );
  });

  it('card: headline only, priority class, you tag, progress, escaped', () => {
    const html = cardHtml(goal({ text: '<b>x</b>: y' }), false);
    expect(html).toContain('fb-card high');
    expect(html).toContain('data-goal="g-11111111"');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('you');
    expect(html).not.toContain('<b>x</b>');
    const done = cardHtml(goal({ section: 'completed', status: 'completed' }), false);
    expect(done).toContain('fb-card done');
    expect(done).not.toContain('draggable');
  });

  it('drawer: title, status and priority segments, subtasks, brief, notes, delete', () => {
    const html = drawerHtml(lane.agent, goal({ notes: 'some notes' }));
    expect(html).toContain('Maintain a living FDE skills map');
    expect(html).toContain('data-st="in_progress"');
    expect(html).toContain('data-pri="high"');
    expect(html).toContain('data-i="1"');
    expect(html).toContain('evals, retrieval');
    expect(html).toContain('some notes');
    expect(html).toContain('id="fb-del"');
  });

  it('drawer: the brief is edited in place, whole, with no Edit / Show full detour', () => {
    const long = `I want you to automate the recruiting process, ${'by scraping sites '.repeat(12)}`;
    const html = drawerHtml(lane.agent, goal({ text: long }));
    expect(html).toMatch(/<textarea[^>]*id="fb-brief"/);
    expect(html).toContain(long.trim());
    expect(html).not.toContain('fb-editbrief');
    expect(html).not.toContain('Show full brief');
  });

  it('card: a headline cut from a longer brief says so and carries the whole text', () => {
    const text =
      'I want you to automate the recruiting process, by starting scraping sites automatically';
    const html = cardHtml(goal({ text }), false);
    expect(html).toContain('I want you to automate the recruiting process…');
    expect(html).toContain(`title="${text}"`);
    // A headline the operator set is the title on purpose: no ellipsis.
    const set = cardHtml(goal({ text, headline: 'Automate recruiting' }), false);
    expect(set).toContain('>Automate recruiting<');
    expect(set).not.toContain('Automate recruiting…');
  });
});

describe('toggleTask keeps the lane in step with the checkbox', () => {
  it('checking a task moves it to done; unchecking sends it back to todo', () => {
    const list = [{ text: 'a', done: false, status: 'in_progress', id: 't-1' }];
    const on = toggleTask(list, 0);
    expect(on[0]).toEqual({ text: 'a', done: true, status: 'done', id: 't-1' });
    expect(toggleTask(on, 0)[0]).toEqual({ text: 'a', done: false, status: 'todo', id: 't-1' });
  });
});

describe('goal activity: is it really being worked on?', () => {
  const H = 3_600_000;
  const DAY = 24 * H;
  const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
  const act = (agoMs: number, cycles7d = 4) => ({
    lastCycleAt: iso(agoMs),
    cycles7d,
    daily: [0, 0, 0, 1, 1, 0, 2],
  });

  it('goalPulse: fresh under one loop interval, quiet up to three, stalled after', () => {
    expect(goalPulse(act(8 * H), DAY, NOW)).toMatchObject({ tone: 'fresh', text: 'worked 8h ago' });
    expect(goalPulse(act(2 * DAY), DAY, NOW)).toMatchObject({
      tone: 'quiet',
      text: 'quiet · 2d ago',
    });
    expect(goalPulse(act(4 * DAY), DAY, NOW)).toMatchObject({
      tone: 'stalled',
      text: 'stalled · 4d ago',
    });
    expect(goalPulse(act(3 * H), 6 * H, NOW).tone).toBe('fresh');
    expect(goalPulse(act(7 * H), 6 * H, NOW).tone).toBe('quiet');
  });

  it('goalPulse: no cycle at all is "never worked", stalled', () => {
    expect(goalPulse(undefined, DAY, NOW)).toMatchObject({
      tone: 'stalled',
      text: 'never worked',
      week: 0,
      daily: [0, 0, 0, 0, 0, 0, 0],
    });
  });

  it('In progress cards carry the pulse line and 7-day bars; other columns do not', () => {
    const ctx = { activity: { 'g-11111111': act(8 * H) }, intervalMs: DAY, nowMs: NOW };
    const html = cardHtml(goal(), false, ctx);
    expect(html).toContain('fb-gpulse fresh');
    expect(html).toContain('worked 8h ago');
    expect(html).toContain('4 cycles / 7d');
    expect((html.match(/<i class="on"/g) ?? []).length).toBe(3);
    expect(cardHtml(goal({ status: 'pending' }), false, ctx)).not.toContain('fb-gpulse');
    expect(cardHtml(goal({ status: 'blocked' }), false, ctx)).not.toContain('fb-gpulse');
  });

  it('the yardstick is how long a goal waits for its turn, else the loop interval', () => {
    expect(goalYardstickMs({ goals: { loopIntervalMs: 2 * H, turnIntervalMs: 13 * H } })).toBe(
      13 * H
    );
    expect(goalYardstickMs({ goals: { loopIntervalMs: 2 * H } })).toBe(2 * H);
    expect(goalYardstickMs(null)).toBeUndefined();
  });

  it('a goal with an end state and no open task says "no tasks yet"; standing and done ones do not', () => {
    const tag = 'no tasks yet';
    expect(cardHtml(goal({ tasks: [] }), false, {})).toContain(tag);
    expect(cardHtml(goal({ tasks: [t('Pick sources', true)] }), false, {})).toContain(tag);
    expect(cardHtml(goal(), false, {})).not.toContain(tag);
    expect(cardHtml(goal({ tasks: [], kind: 'standing' }), false, {})).not.toContain(tag);
    expect(
      cardHtml(goal({ tasks: [], section: 'completed', status: 'completed' }), false, {})
    ).not.toContain(tag);
  });

  it('a card with spawned goals says how many and how many are done', () => {
    const kids = [
      goal({ id: 'g-k1', section: 'completed', status: 'completed' }),
      goal({ id: 'g-k2' }),
    ];
    const html = cardHtml(goal(), false, { spawned: { 'g-11111111': kids }, nowMs: NOW });
    expect(html).toContain('↳ 2 spawned goals · 1 done');
    expect(cardHtml(goal(), false, { spawned: { 'g-11111111': [kids[1]] } })).toContain(
      '↳ 1 spawned goal · 0 done'
    );
    expect(cardHtml(goal(), false, {})).not.toContain('spawned');
  });

  const cycle = (over: Record<string, unknown> = {}) => ({
    cycleId: 'c122e93f-aaaa',
    startedAt: iso(9 * H),
    status: 'completed',
    attribution: 'exact',
    planSummary: 'web_search for vendor postmortems on coding-agent regressions',
    toolCalls: [{ name: 'web_search' }, { name: 'web_search' }, { name: 'web_fetch' }],
    ...over,
  });

  it('activityCycles: only cycles that recorded this goal and did work, newest first', () => {
    const list = activityCycles({
      cycles: [
        cycle({ cycleId: 'old', startedAt: iso(3 * DAY) }),
        cycle({ cycleId: 'weak', attribution: 'weak' }),
        cycle({ cycleId: 'idle', status: 'idle' }),
        cycle({ cycleId: 'new', startedAt: iso(H) }),
      ],
    });
    expect(list.map((c: { cycleId: string }) => c.cycleId)).toEqual(['new', 'old']);
    expect(activityCycles(null)).toEqual([]);
  });

  it('activityHtml: summary, rows with tools and Open cycle, newest first', () => {
    const html = activityHtml(
      { cycles: [cycle(), cycle({ cycleId: 'c2', startedAt: iso(2 * DAY), toolCalls: [] })] },
      { nowMs: NOW, botId: 'ai-perfectionist' }
    );
    expect(html).toContain('fb-act-last fresh');
    expect(html).toContain('9h ago');
    expect(html).toContain('last cycle');
    expect(html).toContain('cycles in 7 days');
    expect(html).toContain('<b>3</b>');
    expect(html).toContain('web_search ×2');
    expect(html).toContain('data-open-cycle="c122e93f-aaaa"');
    expect(html).toContain('data-bot-id="ai-perfectionist"');
    expect(html.indexOf('c122e93f-aaaa')).toBeLessThan(html.indexOf('"c2"'));
  });

  it('activityHtml: a plan summary cut at the log cap ends in an ellipsis, full text on hover', () => {
    const long = 'x'.repeat(200);
    const html = activityHtml(
      { cycles: [cycle({ planSummary: long })] },
      { nowMs: NOW, botId: 'b' }
    );
    expect(html).toContain(`${long}…</div>`);
    expect(html).toContain(`title="${long}"`);
    const short = activityHtml({ cycles: [cycle()] }, { nowMs: NOW, botId: 'b' });
    expect(short).not.toContain('…</div>');
  });

  it('activityHtml: four rows, then "Show all N"', () => {
    const many = {
      cycles: [1, 2, 3, 4, 5, 6].map((n) => cycle({ cycleId: `c${n}`, startedAt: iso(n * H) })),
    };
    const short = activityHtml(many, { nowMs: NOW, botId: 'b' });
    expect((short.match(/data-open-cycle=/g) ?? []).length).toBe(4);
    expect(short).toContain('Show all 6');
    const all = activityHtml(many, { nowMs: NOW, botId: 'b', showAll: true });
    expect((all.match(/data-open-cycle=/g) ?? []).length).toBe(6);
    expect(all).toContain('Show fewer');
  });

  it('activityHtml: loading, failed and empty states say so', () => {
    expect(activityHtml(undefined, { nowMs: NOW })).toContain('Loading activity');
    expect(activityHtml({ error: 'x' }, { nowMs: NOW })).toContain('Could not load activity');
    expect(activityHtml({ cycles: [] }, { nowMs: NOW, inProgress: true })).toContain(
      'In progress only because someone put it there'
    );
    expect(activityHtml({ cycles: [] }, { nowMs: NOW })).toContain('No cycle has served this goal');
  });

  it('spawnedHtml: each spawned goal with who made it, its state and latest notes', () => {
    const html = spawnedHtml([
      goal({
        id: 'g-1001d015',
        text: 'Publish the first daily practitioner digest',
        source: 'reflection:2026-10-11',
        section: 'completed',
        status: 'completed',
        completed: '2026-10-11',
        notes: 'Top priority this cycle.',
      }),
    ]);
    expect(html).toContain('Publish the first daily practitioner digest');
    expect(html).toContain('by reflection');
    expect(html).toContain('added 2026-10-11');
    expect(html).toContain('done 2026-10-11');
    expect(html).toContain('Top priority this cycle.');
    expect(html).toContain('data-open-goal="g-1001d015"');
    expect(spawnedHtml([])).toBe('');
  });

  it('drawer: Spawned and Activity sections after Notes', () => {
    const html = drawerHtml({ id: 'b1', name: 'Bot' }, goal(), {
      nowMs: NOW,
      botId: 'b1',
      detail: { cycles: [cycle()] },
      spawned: [goal({ id: 'g-k', text: 'Kid goal' })],
    });
    const notes = html.indexOf('Notes');
    const kids = html.indexOf('Spawned from this goal');
    const activity = html.indexOf('>Activity<');
    expect(notes).toBeGreaterThan(-1);
    expect(kids).toBeGreaterThan(notes);
    expect(activity).toBeGreaterThan(kids);
    expect(drawerHtml({ id: 'b1' }, goal())).not.toContain('Spawned from this goal');
  });
});

describe('subtask op requests (one op per change, task store endpoints)', () => {
  const tasks = [
    { id: 't-1', text: 'a', done: false, status: 'in_progress' },
    { id: 't-2', text: 'b', done: true, status: 'done' },
    { id: 't-3', text: 'c', done: false, status: 'todo' },
  ];
  const g = { id: 'g-1', text: 'Goal', tasks };

  it('checkbox: moves the task to done, or back to todo, with the rev', () => {
    expect(taskToggleRequest('b1', tasks, 0, 4)).toEqual({
      method: 'PATCH',
      path: '/api/agents/b1/tasks/t-1',
      body: { lane: 'done', expectedRev: 4 },
    });
    expect(taskToggleRequest('b1', tasks, 1, 4)?.body).toEqual({ lane: 'todo', expectedRev: 4 });
    expect(taskToggleRequest('b1', tasks, 9, 4)).toBeNull();
  });

  it('add posts one line to the goal; empty is null', () => {
    expect(taskAddRequest('b1', g, ' x\ny ')).toEqual({
      method: 'POST',
      path: '/api/agents/b1/goals/g-1/tasks',
      body: { text: 'x y' },
    });
    expect(taskAddRequest('b1', g, '  ')).toBeNull();
    expect(taskAddRequest('b1', { text: 'No id' }, 'z')?.path).toBe(
      '/api/agents/b1/goals/No%20id/tasks'
    );
  });

  it('rename patches the text; unchanged or empty is null', () => {
    expect(taskRenameRequest('b1', tasks, 2, ' C ', 4)).toEqual({
      method: 'PATCH',
      path: '/api/agents/b1/tasks/t-3',
      body: { text: 'C', expectedRev: 4 },
    });
    expect(taskRenameRequest('b1', tasks, 2, 'c', 4)).toBeNull();
    expect(taskRenameRequest('b1', tasks, 2, '  ', 4)).toBeNull();
  });

  it('remove deletes by id', () => {
    expect(taskRemoveRequest('b1', tasks, 1)).toEqual({
      method: 'DELETE',
      path: '/api/agents/b1/tasks/t-2',
    });
    expect(taskRemoveRequest('b1', tasks, 7)).toBeNull();
  });

  it('up/down sends the new order of the goal’s task ids', () => {
    expect(taskReorderRequest('b1', g, 2, -1, 4)).toEqual({
      method: 'POST',
      path: '/api/agents/b1/goals/g-1/tasks/reorder',
      body: { ids: ['t-1', 't-3', 't-2'], expectedRev: 4 },
    });
    expect(taskReorderRequest('b1', g, 0, -1, 4)).toBeNull();
  });
});

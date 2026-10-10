import { describe, expect, it } from 'bun:test';
import {
  BOARD_COLUMNS,
  addTask,
  agentLine,
  agentPanel,
  boardColumns,
  cardHtml,
  drawerHtml,
  filterLanes,
  fleetPulse,
  goalHeadline,
  goalRef,
  lastCycle,
  moveTask,
  needsByBot,
  removeTask,
  renameTask,
  stateLine,
  taskProgress,
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
    const long = h(
      'Every day, come up with a different potential idea that can make me a billionaire eventually'
    ).head;
    expect(long.length).toBeLessThanOrEqual(73);
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
});

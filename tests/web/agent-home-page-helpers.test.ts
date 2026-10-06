import { describe, expect, it } from 'bun:test';
import {
  ago,
  goalAddForm,
  goalFormPayload,
  goalMovePayload,
  goalsColumns,
  groupTimelineByHour,
  homeTabs,
  hourLabel,
  karmaBody,
  karmaTone,
  needsYouStrip,
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

describe('goalsColumns (board)', () => {
  it('shows an empty state without goals', () => {
    expect(goalsColumns({ active: [], blocked: [], completedRecently: [] })).toContain(
      'No goals yet'
    );
    expect(goalsColumns(undefined)).toContain('No goals yet');
  });
  it('renders four columns: to do, in progress, blocked, done', () => {
    const html = goalsColumns({
      todo: [{ text: 'Ship <it>', priority: 'high', notes: 'n'.repeat(200) }],
      inProgress: [{ text: 'Doing', status: 'in_progress' }],
      blocked: [],
      completedRecently: [{ text: 'Done thing' }],
    });
    expect(html.match(/class="home-board-col"/g)).toHaveLength(4);
    for (const t of ['To do', 'In progress', 'Blocked', 'Done']) expect(html).toContain(t);
    expect(html.indexOf('Ship &lt;it&gt;')).toBeLessThan(html.indexOf('Doing'));
    expect(html).toContain('pri-high">high<');
    expect(html).toContain(`${'n'.repeat(160)}…`);
    expect(html).toContain('Done thing');
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
    const cols = html.split('class="home-board-col"').slice(1);
    expect(cols[0]).toContain('>A<');
    expect(cols[1]).toContain('>B<');
  });
  it('gives each card a move control with its current column selected', () => {
    const html = goalsColumns({
      todo: [],
      inProgress: [{ text: 'Say "hi"', status: 'in_progress' }],
      blocked: [],
      completedRecently: [],
    });
    expect(html).toContain('data-goal="Say &quot;hi&quot;"');
    expect(html).toMatch(/<option value="in_progress" selected>/);
    expect(html).toContain('<option value="done">');
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

describe('goals board polish', () => {
  it('shows a priority chip only for non-default priorities', () => {
    const html = goalsColumns({
      todo: [
        { text: 'Hi', priority: 'high' },
        { text: 'Mid', priority: 'medium' },
      ],
      inProgress: [],
      blocked: [],
      completedRecently: [],
    });
    expect(html).toContain('pri-high');
    expect(html).not.toContain('pri-medium');
  });
  it('marks empty columns so their count can be dimmed', () => {
    const html = goalsColumns({
      todo: [{ text: 'A' }],
      inProgress: [],
      blocked: [],
      completedRecently: [],
    });
    expect(html).toContain('data-status="pending">');
    expect(html).toContain('data-status="blocked" data-empty');
  });
});

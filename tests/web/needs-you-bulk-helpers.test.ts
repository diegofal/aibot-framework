import { describe, expect, it } from 'bun:test';
import {
  KIND_LABEL,
  NEUTRAL_KINDS,
  SHORTCUTS,
  ageGroupOf,
  bulkActions,
  bulkPlan,
  checkAllVisible,
  clearChecked,
  createLoadGate,
  detailPanel,
  filterBar,
  groupItems,
  hideItems,
  initialState,
  kindCounts,
  listBody,
  listToolbar,
  moveSelection,
  neutralIds,
  reduceKey,
  setFilter,
  staleClearIds,
  summarizeBulk,
  toggleAllVisible,
  toggleChecked,
  unhideItems,
  visibleItems,
} from '../../web/pages/needs-you-helpers.js';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const mk = (id: string, kind: string, botId: string, ageH: number, extra = {}) => ({
  id,
  kind,
  botId,
  botName: botId === 'b1' ? 'Bot One' : 'Bot <Two>',
  title: `T ${id}`,
  body: 'b',
  options: null,
  createdAt: iso(NOW - ageH * H),
  urgency: 'normal',
  actions: [],
  href: '#/needs',
  meta: {},
  ...extra,
});

// Server order: urgency then newest — the old ask comes before the fresh production.
const items = [
  mk('ask:old', 'ask', 'b1', 200),
  mk('production:b1:f1', 'production', 'b1', 2),
  mk('permission:p1', 'permission', 'b2', 30),
  mk('tool:t1', 'tool', 'b2', 100),
  mk('production:b2:f2', 'production', 'b2', 1),
];
const ids = (list: Array<{ id: string }>) => list.map((i) => i.id);

describe('age groups', () => {
  it('buckets by age: < 24 h today, < 7 d this week, else older', () => {
    expect(ageGroupOf(iso(NOW - 2 * H), NOW)).toBe('today');
    expect(ageGroupOf(iso(NOW - 30 * H), NOW)).toBe('week');
    expect(ageGroupOf(iso(NOW - 8 * 24 * H), NOW)).toBe('older');
    expect(ageGroupOf('garbage', NOW)).toBe('older');
  });

  it('groupItems keeps server order inside each group and drops empty groups', () => {
    const groups = groupItems(items, NOW);
    expect(groups.map((g: { id: string }) => g.id)).toEqual(['today', 'week', 'older']);
    expect(ids(groups[0].items)).toEqual(['production:b1:f1', 'production:b2:f2']);
    expect(ids(groups[1].items)).toEqual(['permission:p1', 'tool:t1']);
    expect(ids(groups[2].items)).toEqual(['ask:old']);
    expect(groups[0].label).toBe('Today');
    expect(groupItems([], NOW)).toEqual([]);
  });
});

describe('filter + visibility', () => {
  const s0 = initialState(items, null, { nowMs: NOW });

  it('visible items follow display (group) order and the first one is selected', () => {
    expect(ids(visibleItems(s0))).toEqual([
      'production:b1:f1',
      'production:b2:f2',
      'permission:p1',
      'tool:t1',
      'ask:old',
    ]);
    expect(s0.selectedId).toBe('production:b1:f1');
  });

  it('j/k move through display order', () => {
    const s = moveSelection(s0, 2);
    expect(s.selectedId).toBe('permission:p1');
  });

  it('setFilter narrows by kind and agent, reselects, and prunes the selection set', () => {
    let s = toggleChecked(s0, 'permission:p1');
    s = setFilter(s, { kind: 'production' });
    expect(ids(visibleItems(s))).toEqual(['production:b1:f1', 'production:b2:f2']);
    expect(s.checked).toEqual([]);
    s = setFilter(s, { botId: 'b2' });
    expect(ids(visibleItems(s))).toEqual(['production:b2:f2']);
    expect(s.selectedId).toBe('production:b2:f2');
    s = setFilter(s, { kind: null, botId: null });
    expect(visibleItems(s)).toHaveLength(5);
  });

  it('kindCounts counts per kind under the agent filter, ignoring hidden rows', () => {
    let s = setFilter(s0, { botId: 'b2' });
    s = hideItems(s, ['tool:t1']);
    expect(kindCounts(s)).toEqual({
      all: 2,
      ask: 0,
      permission: 1,
      proposal: 0,
      production: 1,
      feedback: 0,
      tool: 0,
      edited: 0,
    });
  });

  it('hideItems removes rows optimistically (selection moves on) and unhideItems restores them', () => {
    let s = toggleChecked(s0, 'production:b1:f1');
    s = hideItems(s, ['production:b1:f1', 'production:b2:f2']);
    expect(ids(visibleItems(s))).toEqual(['permission:p1', 'tool:t1', 'ask:old']);
    expect(s.selectedId).toBe('permission:p1');
    expect(s.checked).toEqual([]);
    s = unhideItems(s, ['production:b2:f2']);
    expect(visibleItems(s)).toHaveLength(4);
  });

  it('initialState carries filter, selection set and hidden rows across reloads', () => {
    let s = setFilter(s0, { kind: 'production' });
    s = toggleChecked(s, 'production:b2:f2');
    s = hideItems(s, ['production:b1:f1']);
    const next = initialState(items, s.selectedId, {
      nowMs: NOW,
      filter: s.filter,
      checked: s.checked,
      hidden: s.hidden,
    });
    expect(next.filter).toEqual({ kind: 'production', botId: null });
    expect(next.checked).toEqual(['production:b2:f2']);
    expect(ids(visibleItems(next))).toEqual(['production:b2:f2']);
    // Ids that no longer exist are dropped.
    const gone = initialState([], null, { checked: ['x'], hidden: ['y'] });
    expect(gone.checked).toEqual([]);
    expect(gone.hidden).toEqual([]);
  });
});

describe('selection set', () => {
  const s0 = initialState(items, null, { nowMs: NOW });

  it('toggleChecked / checkAllVisible / clearChecked', () => {
    let s = toggleChecked(s0, 'tool:t1');
    expect(s.checked).toEqual(['tool:t1']);
    s = toggleChecked(s, 'tool:t1');
    expect(s.checked).toEqual([]);
    s = checkAllVisible(setFilter(s0, { botId: 'b1' }));
    expect(s.checked).toEqual(['production:b1:f1', 'ask:old']);
    expect(clearChecked(s).checked).toEqual([]);
  });

  it('x toggles the focused row, Shift+j/k extend, * selects all visible, Escape clears', () => {
    let r = reduceKey(s0, 'x');
    expect(r.state.checked).toEqual(['production:b1:f1']);
    r = reduceKey(r.state, 'J');
    expect(r.state.selectedId).toBe('production:b2:f2');
    expect(r.state.checked).toEqual(['production:b1:f1', 'production:b2:f2']);
    r = reduceKey(r.state, 'J');
    expect(r.state.checked).toHaveLength(3);
    r = reduceKey(r.state, 'K');
    expect(r.state.selectedId).toBe('production:b2:f2');
    // Going back over a row keeps it selected (extend, not toggle).
    expect(r.state.checked).toHaveLength(3);
    r = reduceKey(r.state, '*');
    expect(r.state.checked).toHaveLength(5);
    r = reduceKey(r.state, 'Escape');
    expect(r.state.checked).toEqual([]);
    expect(r.effect.type).toBe('none');
  });

  it('* and the select-all box toggle: all visible selected → unselect them', () => {
    let r = reduceKey(s0, '*');
    expect(r.state.checked).toHaveLength(5);
    r = reduceKey(r.state, '*');
    expect(r.state.checked).toEqual([]);
    const once = toggleAllVisible(setFilter(s0, { botId: 'b1' }));
    expect(once.checked).toEqual(['production:b1:f1', 'ask:old']);
    expect(toggleAllVisible(once).checked).toEqual([]);
  });

  it('listToolbar: one bar with the select-all box, count and in-place actions', () => {
    const idle = listToolbar(s0);
    expect(idle).toContain('id="needs-select-all"');
    expect(idle).toContain('data-state="none"');
    expect(idle).toContain('Select all');
    expect(idle).toContain('5 items');
    expect(idle).not.toContain('data-bulk=');
    expect(idle).not.toContain('has-selection');

    const some = listToolbar(toggleChecked(s0, 'tool:t1'));
    expect(some).toContain('data-state="some"');
    expect(some).toContain('1 of 5 selected');
    expect(some).toContain('has-selection');
    expect(some).toContain('data-bulk="approve"');
    expect(some).toContain('data-bulk="reject"');
    expect(some).toContain('data-bulk="delete"');

    const all = listToolbar(toggleAllVisible(s0));
    expect(all).toContain('data-state="all"');
    expect(all).toContain(' checked');
    expect(all).toContain('All 5 selected');

    expect(listToolbar(initialState([], null, { nowMs: NOW }))).toBe('');
  });

  it('Shift+J from an unchecked row checks both ends', () => {
    const r = reduceKey(s0, 'J');
    expect(r.state.checked).toEqual(['production:b1:f1', 'production:b2:f2']);
  });
});

describe('bulk', () => {
  it('bulkPlan counts what each button would touch', () => {
    const plan = bulkPlan(items, ['production:b1:f1', 'tool:t1', 'ask:old']);
    expect(plan).toMatchObject({
      count: 3,
      productionIds: ['production:b1:f1'],
      approveIds: ['production:b1:f1', 'tool:t1'],
      rejectIds: ['production:b1:f1', 'tool:t1'],
      toolIds: ['tool:t1'],
    });
    expect(bulkPlan(items, ['permission:p1']).approveIds).toEqual([]);
    expect(bulkPlan(items, []).count).toBe(0);
    // Ids not in the list are ignored.
    expect(bulkPlan(items, ['nope']).count).toBe(0);
  });

  it('bulkActions: approve / reject / dismiss / archive / delete, each counting what it sends', () => {
    const byId = (plan: ReturnType<typeof bulkPlan>) =>
      Object.fromEntries(bulkActions(plan).map((a) => [a.id, a.count]));
    expect(byId(bulkPlan(items, ['production:b1:f1', 'tool:t1']))).toEqual({
      approve: 2,
      reject: 2,
      neutral: 1,
      archive: 1,
      delete: 1,
    });
    // Only tools: no Dismiss / Archive (tools have no neutral action).
    expect(byId(bulkPlan(items, ['tool:t1']))).toMatchObject({
      approve: 1,
      reject: 1,
      neutral: 0,
      delete: 1,
    });
    // Asks and permissions are never approved, rejected or deleted in bulk.
    expect(byId(bulkPlan(items, ['ask:old', 'permission:p1']))).toMatchObject({
      approve: 0,
      reject: 0,
      neutral: 2,
      delete: 0,
    });
  });

  it('tools have no neutral action: neutralIds and bulkPlan.neutralIds skip them', () => {
    expect(NEUTRAL_KINDS.has('tool')).toBe(false);
    expect(neutralIds(items)).toEqual([
      'ask:old',
      'production:b1:f1',
      'permission:p1',
      'production:b2:f2',
    ]);
    const plan = bulkPlan(items, ['production:b1:f1', 'tool:t1']);
    expect(plan.neutralIds).toEqual(['production:b1:f1']);
  });

  it('staleClearIds picks old non-tool items, scoped by agent, skipping hidden ids', () => {
    const extra = [...items, mk('feedback:b1:x', 'feedback', 'b1', 80)];
    expect(staleClearIds(extra, { hours: 72, nowMs: NOW })).toEqual(['ask:old', 'feedback:b1:x']);
    expect(staleClearIds(extra, { hours: 72, nowMs: NOW, botId: 'b2' })).toEqual([]);
    expect(staleClearIds(extra, { hours: 24, nowMs: NOW, botId: 'b2' })).toEqual(['permission:p1']);
    expect(staleClearIds(extra, { hours: 72, nowMs: NOW, hidden: ['ask:old'] })).toEqual([
      'feedback:b1:x',
    ]);
  });

  it('createLoadGate drops responses of loads started before the latest commit', () => {
    const gate = createLoadGate();
    const before = gate.begin();
    expect(gate.accepts(before)).toBe(true);
    gate.invalidate();
    expect(gate.accepts(before)).toBe(false);
    const after = gate.begin();
    expect(gate.accepts(after)).toBe(true);
    // A newer load supersedes an older one even without a commit.
    const newer = gate.begin();
    expect(gate.accepts(after)).toBe(false);
    expect(gate.accepts(newer)).toBe(true);
  });

  it('summarizeBulk reads the per-item results', () => {
    expect(
      summarizeBulk(
        [
          { id: 'a', ok: true },
          { id: 'b', ok: true },
        ],
        'Dismissed'
      )
    ).toEqual({ ok: 2, failed: 0, failedIds: [], text: 'Dismissed 2' });
    const mixed = summarizeBulk(
      [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'x' },
      ],
      'Archived'
    );
    expect(mixed.text).toBe('Archived 1 · 1 failed');
    expect(mixed.failedIds).toEqual(['b']);
    expect(summarizeBulk(null as never, 'Dismissed').failed).toBe(0);
  });
});

describe('markup', () => {
  const s0 = initialState(items, null, { nowMs: NOW });

  it('filterBar renders kind chips with counts and an agent select', () => {
    const html = filterBar(setFilter(s0, { kind: 'production' }));
    expect(html).toContain('data-filter-kind=""');
    expect(html).toContain('data-filter-kind="production"');
    expect(html).toMatch(/data-filter-kind="production"[^>]*aria-pressed="true"/);
    expect(html).toContain('All <span class="needs-filter-n">5</span>');
    expect(html).toContain('<select');
    expect(html).toContain('data-page-filter');
    expect(html).toContain('value="b2"');
    expect(html).toContain('Bot &lt;Two&gt;');
    // Kinds with zero items are not offered.
    expect(html).not.toContain('data-filter-kind="proposal"');
  });

  it('filterBar keeps a pre-applied agent (#/needs?bot=) selectable when it has no items', () => {
    const html = filterBar(setFilter(s0, { botId: 'ghost' }));
    expect(html).toContain('<option value="ghost" selected>ghost</option>');
  });

  it('listBody renders age-group headers with a Clear button and row checkboxes', () => {
    const html = listBody(visibleItems(s0), s0.selectedId, NOW, ['tool:t1']);
    expect(html).toContain('data-group="today"');
    expect(html).toContain('data-group="older"');
    expect(html).toContain('data-clear-group="older"');
    expect(html).toContain('Clear 1');
    // The week group holds a permission and a tool: Clear only counts the permission.
    expect(html).toMatch(/data-clear-group="week"[^>]*>Clear 1</);
    expect(html).toContain('data-check-id="tool:t1"');
    expect(html).toMatch(/data-check-id="tool:t1"[^>]*checked/);
    expect(html.match(/class="needs-row(?: selected)?"/g)?.length).toBe(5);
  });

  it('listBody omits the Clear button for a group holding only tools', () => {
    const html = listBody([mk('tool:t9', 'tool', 'b1', 200)], null, NOW);
    expect(html).toContain('data-group="older"');
    expect(html).not.toContain('data-clear-group');
  });

  it('a delete action with confirm renders as a secondary button without hotkey', () => {
    const html = detailPanel(
      mk('ask:c', 'ask', 'b1', 1, {
        actions: [
          {
            id: 'delete',
            label: 'Delete conversation',
            method: 'DELETE',
            path: '/api/conversations/b1/c',
            tone: 'danger',
            confirm: 'Sure?',
          },
        ],
      }),
      {},
      NOW
    );
    expect(html).toContain('data-action="delete"');
    expect(html).toContain('Delete conversation');
  });

  it('knows the tool kind and documents the new keys', () => {
    expect(KIND_LABEL.tool).toBeTruthy();
    const keys = SHORTCUTS.map(([k]: [string]) => k).join(' ');
    for (const k of ['x', 'Shift', '*']) expect(keys).toContain(k);
  });
});

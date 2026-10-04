import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_LIST_PREFS,
  LIST_PREFS_KEY,
  agentHasError,
  agentMenuItems,
  agentStatus,
  agentsTable,
  bulkPlan,
  bulkSummary,
  filterAgents,
  listFilterBar,
  readListPrefs,
  sortAgents,
  statusCounts,
  writeListPrefs,
} from '../../web/pages/agents-list-helpers.js';

const a = (over) => ({ id: 'x', name: 'X', enabled: true, running: false, skills: [], ...over });
const running = a({ id: 'ada', name: 'Ada', running: true, model: 'llama3' });
const stopped = a({ id: 'bob', name: 'bob', running: false, llmBackend: 'claude-cli' });
const disabled = a({ id: 'cy', name: 'Cy', enabled: false });
const revoked = a({ id: 'dee', name: 'Dee', running: true, channel: { state: 'revoked' } });
const all = [stopped, revoked, disabled, running];

function memStorage(init = {}) {
  const data = { ...init };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    data,
  };
}

describe('agentStatus / agentHasError', () => {
  it('maps running, stopped and disabled', () => {
    expect(agentStatus(running)).toBe('running');
    expect(agentStatus(stopped)).toBe('stopped');
    expect(agentStatus(disabled)).toBe('disabled');
  });
  it('flags a broken channel or failed LLM calls as an error', () => {
    expect(agentHasError(revoked)).toBe(true);
    expect(agentHasError(a({ channel: { state: 'error' } }))).toBe(true);
    expect(agentHasError(running, { failCount: 2 })).toBe(true);
    expect(agentHasError(running, { failCount: 0 })).toBe(false);
    expect(agentHasError(a({ channel: { state: 'placeholder' } }))).toBe(false);
  });
});

describe('filterAgents', () => {
  it('matches the query against name, id and model, case-insensitively', () => {
    expect(filterAgents(all, { query: 'ADA' }).map((x) => x.id)).toEqual(['ada']);
    expect(filterAgents(all, { query: 'llama' }).map((x) => x.id)).toEqual(['ada']);
    expect(filterAgents(all, { query: 'claude' }).map((x) => x.id)).toEqual(['bob']);
    expect(filterAgents(all, { query: 'dee' }).map((x) => x.id)).toEqual(['dee']);
  });
  it('filters by status chip', () => {
    expect(filterAgents(all, { status: 'running' }).map((x) => x.id)).toEqual(['dee', 'ada']);
    expect(filterAgents(all, { status: 'stopped' }).map((x) => x.id)).toEqual(['bob']);
    expect(filterAgents(all, { status: 'disabled' }).map((x) => x.id)).toEqual(['cy']);
    expect(
      filterAgents(all, { status: 'errors' }, { llmStatsMap: { bob: { failCount: 1 } } }).map(
        (x) => x.id
      )
    ).toEqual(['bob', 'dee']);
  });
  it('returns everything for all / empty prefs', () => {
    expect(filterAgents(all, {}).length).toBe(4);
    expect(filterAgents(all, { status: 'all', query: '  ' }).length).toBe(4);
  });
});

describe('statusCounts', () => {
  it('counts each chip', () => {
    expect(statusCounts(all)).toEqual({ all: 4, running: 2, stopped: 1, disabled: 1, errors: 1 });
  });
});

describe('sortAgents', () => {
  it('sorts by name both ways without mutating', () => {
    const copy = [...all];
    expect(sortAgents(all, { sort: 'name', dir: 'asc' }).map((x) => x.id)).toEqual([
      'ada',
      'bob',
      'cy',
      'dee',
    ]);
    expect(sortAgents(all, { sort: 'name', dir: 'desc' }).map((x) => x.id)).toEqual([
      'dee',
      'cy',
      'bob',
      'ada',
    ]);
    expect(all).toEqual(copy);
  });
  it('sorts by status running < stopped < disabled, then name', () => {
    expect(sortAgents(all, { sort: 'status', dir: 'asc' }).map((x) => x.id)).toEqual([
      'ada',
      'dee',
      'bob',
      'cy',
    ]);
  });
  it('sorts by karma with missing scores last', () => {
    const karmaMap = { ada: { current: 40 }, bob: { current: 90 } };
    expect(sortAgents(all, { sort: 'karma', dir: 'desc' }, { karmaMap }).map((x) => x.id)).toEqual([
      'bob',
      'ada',
      'cy',
      'dee',
    ]);
    expect(sortAgents(all, { sort: 'karma', dir: 'asc' }, { karmaMap }).map((x) => x.id)).toEqual([
      'ada',
      'bob',
      'cy',
      'dee',
    ]);
  });
  it('sorts by last activity (lastCallAt)', () => {
    const llmStatsMap = {
      cy: { lastCallAt: '2026-10-03T10:00:00Z' },
      ada: { lastCallAt: '2026-10-01T10:00:00Z' },
    };
    expect(
      sortAgents(all, { sort: 'activity', dir: 'desc' }, { llmStatsMap }).map((x) => x.id)
    ).toEqual(['cy', 'ada', 'bob', 'dee']);
  });
});

describe('list prefs', () => {
  it('reads defaults when nothing or garbage is stored', () => {
    expect(readListPrefs(memStorage())).toEqual(DEFAULT_LIST_PREFS);
    expect(readListPrefs(memStorage({ [LIST_PREFS_KEY]: '{nope' }))).toEqual(DEFAULT_LIST_PREFS);
    expect(readListPrefs(null)).toEqual(DEFAULT_LIST_PREFS);
  });
  it('round-trips and drops invalid values', () => {
    const s = memStorage();
    writeListPrefs(s, { query: 'ad', status: 'running', sort: 'karma', dir: 'desc' });
    expect(readListPrefs(s)).toEqual({
      query: 'ad',
      status: 'running',
      sort: 'karma',
      dir: 'desc',
    });
    s.setItem(LIST_PREFS_KEY, JSON.stringify({ status: 'bogus', sort: 'nope', dir: 'up' }));
    expect(readListPrefs(s)).toEqual(DEFAULT_LIST_PREFS);
  });
  it('never throws when storage throws', () => {
    const bad = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    };
    expect(readListPrefs(bad)).toEqual(DEFAULT_LIST_PREFS);
    expect(() => writeListPrefs(bad, DEFAULT_LIST_PREFS)).not.toThrow();
  });
});

describe('listFilterBar', () => {
  it('renders the search box and chips with counts, marking the active one', () => {
    const html = listFilterBar({ query: 'a"b', status: 'running' }, statusCounts(all));
    expect(html).toContain('data-page-filter');
    expect(html).toContain('value="a&quot;b"');
    expect(html).toContain('data-status-filter="running"');
    expect(html).toMatch(/data-status-filter="running"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-status-filter="all"[^>]*aria-pressed="false"/);
    expect(html).toContain('Errors');
  });
});

describe('agentsTable sorting headers', () => {
  it('marks sortable headers and the active sort direction', () => {
    const html = agentsTable(all, { sort: { sort: 'karma', dir: 'desc' } });
    expect(html).toContain('data-sort="name"');
    expect(html).toContain('data-sort="status"');
    expect(html).toContain('data-sort="karma"');
    expect(html).toContain('data-sort="activity"');
    expect(html).toMatch(
      /aria-sort="descending"[^>]*data-sort="karma"|data-sort="karma"[^>]*aria-sort="descending"/
    );
    expect(html).toContain('id="bulk-select-all"');
  });
  it('shows a no-match state when filters hide every agent', () => {
    const html = agentsTable([], { filtered: true });
    expect(html).toContain('No agents match');
    expect(html).toContain('data-action="clear-filters"');
  });
});

describe('menu labels', () => {
  it('uses "Run now" for the agent-loop trigger', () => {
    expect(agentMenuItems(running).find((i) => i?.action === 'run-loop')?.label).toBe('Run now');
  });
});

describe('bulkPlan', () => {
  it('splits ids into the ones the action applies to and the ones it skips', () => {
    const ids = ['ada', 'bob', 'cy', 'dee'];
    expect(bulkPlan('start', all, ids)).toEqual({ apply: ['bob', 'cy'], skip: ['ada', 'dee'] });
    expect(bulkPlan('stop', all, ids)).toEqual({ apply: ['ada', 'dee'], skip: ['bob', 'cy'] });
    expect(bulkPlan('enable', all, ids)).toEqual({ apply: ['cy'], skip: ['ada', 'bob', 'dee'] });
    expect(bulkPlan('disable', all, ids)).toEqual({ apply: ['ada', 'bob', 'dee'], skip: ['cy'] });
    expect(bulkPlan('delete', all, ids)).toEqual({ apply: ids, skip: [] });
    expect(bulkPlan('export', all, ['ada', 'ghost'])).toEqual({ apply: ['ada'], skip: ['ghost'] });
  });
});

describe('bulkSummary', () => {
  it('reports a clean run as ok', () => {
    expect(
      bulkSummary('Started', [
        { id: 'a', ok: true },
        { id: 'b', ok: true },
      ])
    ).toEqual({
      text: 'Started 2 agents',
      tone: 'ok',
    });
  });
  it('reports failures and skips', () => {
    const s = bulkSummary(
      'Stopped',
      [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'boom' },
      ],
      1
    );
    expect(s.tone).toBe('warn');
    expect(s.text).toContain('Stopped 1 agent');
    expect(s.text).toContain('1 failed (b: boom)');
    expect(s.text).toContain('1 skipped');
  });
  it('is danger when everything failed, muted when nothing applied', () => {
    expect(bulkSummary('Started', [{ id: 'a', ok: false, error: 'x' }]).tone).toBe('danger');
    expect(bulkSummary('Started', [], 3)).toEqual({
      text: 'Nothing to do · 3 skipped',
      tone: 'muted',
    });
  });
});

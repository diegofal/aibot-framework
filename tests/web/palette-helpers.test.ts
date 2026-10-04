/**
 * Command palette ranking (session S8 of docs/plans/jarvis-fleet-plan.md).
 * Pure helpers: match scoring, ranking with a stable tie-break, item builders
 * over the nav model and the agents list, list markup, key handling.
 */
import { describe, expect, it } from 'bun:test';
import { AREAS, visibleAreas, visibleTabs } from '../../web/nav-routes.js';
import {
  KIND_LABEL,
  PALETTE_LIMIT,
  RECENTS_MAX,
  buildActionItems,
  buildAgentItems,
  buildItems,
  buildPageItems,
  isEditableTarget,
  isPaletteHotkey,
  matchScore,
  moveIndex,
  paletteMarkup,
  paletteShell,
  pushRecent,
  rankItems,
} from '../../web/ui/palette-helpers.js';

const ADMIN = { multiTenant: true, role: 'admin' };
const TENANT = { multiTenant: true, role: 'tenant' };
const AGENTS = [
  { id: 'hunter', name: 'Hunter', enabled: true, running: true },
  { id: 'echo', name: 'Echo <b>', enabled: true, running: false },
  { id: 'scout', name: 'Scout', enabled: false, running: false },
];

describe('matchScore', () => {
  it('ranks exact > prefix > word start > substring > fuzzy > nothing', () => {
    const exact = matchScore('cron', 'Cron');
    const prefix = matchScore('cro', 'Cron jobs');
    const wordStart = matchScore('job', 'Cron jobs');
    const substring = matchScore('ron', 'Cron jobs');
    const fuzzy = matchScore('cj', 'Cron jobs');
    const none = matchScore('xyz', 'Cron jobs');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
    expect(none).toBe(0);
  });

  it('is case-insensitive, ignores surrounding spaces and treats an empty query as no match', () => {
    expect(matchScore('  HUNTER ', 'hunter')).toBe(matchScore('hunter', 'Hunter'));
    expect(matchScore('', 'anything')).toBe(0);
    expect(matchScore('a', '')).toBe(0);
  });
});

describe('rankItems', () => {
  const items = [
    { id: 'a', kind: 'page', label: 'Automations › Cron', keywords: ['schedule'] },
    { id: 'b', kind: 'agent', label: 'Cronos', hint: 'cronos' },
    { id: 'c', kind: 'page', label: 'Insights › Karma' },
    { id: 'd', kind: 'action', label: 'Run Cronos now' },
    { id: 'e', kind: 'page', label: 'Work › Conversations' },
  ].map((it, index) => ({ ...it, index }));

  it('prefix beats substring beats fuzzy, with the input order as the tie-break', () => {
    const ids = rankItems(items, 'cron').map((i) => i.id);
    // "Cronos" (prefix on label) first; "Automations › Cron" (word start) next;
    // "Run Cronos now" (word start, later) after it; nothing for Karma / Conversations beyond fuzzy.
    expect(ids.slice(0, 3)).toEqual(['b', 'a', 'd']);
    expect(ids.indexOf('e')).toBeGreaterThan(ids.indexOf('d'));
  });

  it('is stable: equal scores keep their input order every time', () => {
    const twins = [
      { id: 'x1', kind: 'page', label: 'Same label' },
      { id: 'x2', kind: 'page', label: 'Same label' },
      { id: 'x3', kind: 'page', label: 'Same label' },
    ].map((it, index) => ({ ...it, index }));
    for (let i = 0; i < 5; i++) {
      expect(rankItems(twins, 'same').map((t) => t.id)).toEqual(['x1', 'x2', 'x3']);
    }
  });

  it('matches keywords and hints too, a little below the label', () => {
    const ids = rankItems(items, 'schedule').map((i) => i.id);
    expect(ids).toEqual(['a']);
    expect(rankItems(items, 'cronos')[0].id).toBe('b');
  });

  it('with an empty query lists recents first, then pages, capped', () => {
    const ids = rankItems(items, '', { recents: ['d', 'zzz', 'b'] }).map((i) => i.id);
    expect(ids).toEqual(['d', 'b', 'a', 'c', 'e']);
    expect(rankItems(items, '   ', { recents: [], limit: 2 }).map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('caps the list at PALETTE_LIMIT by default', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `p${index}`,
      kind: 'page',
      label: `Page ${index}`,
      index,
    }));
    expect(rankItems(many, 'page')).toHaveLength(PALETTE_LIMIT);
    expect(rankItems(many, '')).toHaveLength(PALETTE_LIMIT);
  });
});

describe('item builders', () => {
  it('buildAgentItems: name/id searchable, goes to the Agent Home', () => {
    const items = buildAgentItems(AGENTS);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      id: 'agent:hunter',
      kind: 'agent',
      label: 'Hunter',
      hint: 'hunter',
      href: '#/agents/hunter',
    });
    expect(items[1].label).toBe('Echo <b>');
    expect(rankItems(items, 'sco')[0].id).toBe('agent:scout');
    expect(buildAgentItems(null)).toEqual([]);
  });

  it('buildPageItems: every visible area and tab, deduped by href, honouring the auth context', () => {
    const admin = buildPageItems(ADMIN);
    const hrefs = new Set(admin.map((i) => i.href));
    for (const area of visibleAreas(ADMIN)) {
      for (const tab of visibleTabs(area, ADMIN)) expect(hrefs.has(tab.href)).toBe(true);
    }
    expect(hrefs.size).toBe(admin.length);
    expect(admin.find((i) => i.href === '#/automations/cron')?.label).toBe('Automations › Cron');
    expect(admin.find((i) => i.href === '#/')?.label).toBe('Home');
    const tenant = buildPageItems(TENANT);
    expect(tenant.some((i) => i.href === '#/automations/tools')).toBe(false);
    expect(tenant.some((i) => i.href === '#/settings/baas/tenants')).toBe(false);
    expect(admin.some((i) => i.href === '#/automations/tools')).toBe(true);
    // A custom areas list is accepted (tests / future areas).
    expect(buildPageItems(ADMIN, AREAS.slice(0, 1)).map((i) => i.href)).toEqual(['#/']);
  });

  it('buildActionItems: start/stop/run now per agent, plus new agent, Needs You and theme', () => {
    const items = buildActionItems(AGENTS, { theme: 'dark' });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId['action:stop:hunter']).toMatchObject({
      kind: 'action',
      label: 'Stop Hunter',
      api: { path: '/api/agents/hunter/stop', method: 'POST' },
    });
    expect(byId['action:run:hunter']).toMatchObject({
      label: 'Run Hunter now',
      api: { path: '/api/agent-loop/run/hunter', method: 'POST' },
    });
    expect(byId['action:start:hunter']).toBeUndefined();
    expect(byId['action:start:echo']).toMatchObject({
      label: 'Start Echo <b>',
      api: { path: '/api/agents/echo/start', method: 'POST' },
    });
    expect(byId['action:run:echo']).toBeUndefined();
    // A disabled agent is started with ?enable=true, like the Home header does.
    expect(byId['action:start:scout'].api.path).toBe('/api/agents/scout/start?enable=true');
    expect(byId['action:config:hunter']).toMatchObject({ href: '#/agents/hunter/config' });
    expect(byId['action:new-agent']).toMatchObject({ href: '#/agents/new', label: 'New agent' });
    expect(byId['action:needs']).toMatchObject({ href: '#/needs', label: 'Open Needs You' });
    expect(byId['action:theme']).toMatchObject({ theme: true, label: 'Switch to light theme' });
    expect(
      buildActionItems([], { theme: 'light' }).find((i) => i.id === 'action:theme')?.label
    ).toBe('Switch to dark theme');
  });

  it('buildItems stamps the index used for the stable tie-break', () => {
    const all = buildItems({ agents: AGENTS, ctx: ADMIN, theme: 'dark' });
    expect(all.map((i) => i.index)).toEqual(all.map((_, i) => i));
    expect(all[0].kind).toBe('agent');
    expect(all.some((i) => i.kind === 'page')).toBe(true);
    expect(all.some((i) => i.kind === 'action')).toBe(true);
    // Typing an agent name finds the agent before its actions.
    expect(rankItems(all, 'hunter')[0].id).toBe('agent:hunter');
  });
});

describe('keys and recents', () => {
  it('moveIndex wraps in both directions and copes with an empty list', () => {
    expect(moveIndex(0, 1, 3)).toBe(1);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(0, 1, 0)).toBe(0);
  });

  it('pushRecent puts the id first, dedupes and caps', () => {
    expect(pushRecent(['a', 'b'], 'b')).toEqual(['b', 'a']);
    expect(pushRecent(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
    const full = Array.from({ length: RECENTS_MAX }, (_, i) => `r${i}`);
    expect(pushRecent(full, 'new')).toHaveLength(RECENTS_MAX);
    expect(pushRecent(full, 'new')[0]).toBe('new');
    expect(pushRecent(null, 'x')).toEqual(['x']);
  });

  it('isPaletteHotkey: Ctrl+K / Cmd+K only', () => {
    expect(isPaletteHotkey({ key: 'k', ctrlKey: true })).toBe(true);
    expect(isPaletteHotkey({ key: 'K', metaKey: true })).toBe(true);
    expect(isPaletteHotkey({ key: 'k' })).toBe(false);
    expect(isPaletteHotkey({ key: 'k', ctrlKey: true, altKey: true })).toBe(false);
    expect(isPaletteHotkey({ key: 'j', ctrlKey: true })).toBe(false);
  });

  it('isEditableTarget: inputs, textareas, selects and contenteditable', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('markup', () => {
  it('paletteMarkup lists rows with kind, label and hint, marks the active one, escapes', () => {
    const items = [
      { id: 'agent:echo', kind: 'agent', label: 'Echo <b>', hint: 'echo' },
      { id: 'page:x', kind: 'page', label: 'Automations › Cron', hint: '#/automations/cron' },
    ];
    const html = paletteMarkup(items, 1);
    expect(html).toContain('data-index="0"');
    expect(html).toContain('data-id="agent:echo"');
    expect(html).toContain('Echo &lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).toContain(KIND_LABEL.agent);
    expect(html).toMatch(/class="ui-palette-row active"[^>]*data-index="1"/);
    expect(html).toContain('aria-selected="true"');
  });

  it('paletteMarkup says when nothing matches', () => {
    expect(paletteMarkup([], 0, { query: 'zzz' })).toContain('No matches');
    expect(paletteMarkup([], 0, { query: '' })).toContain('Type to search');
  });

  it('paletteShell has the input, the list and the hint row', () => {
    const html = paletteShell();
    expect(html).toContain('id="ui-palette-input"');
    expect(html).toContain('id="ui-palette-list"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-palette-close');
    expect(html).toContain('Esc');
  });
});

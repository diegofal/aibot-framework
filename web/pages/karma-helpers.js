/**
 * Karma list helpers (UX overhaul phase 4): agent names instead of raw
 * botIds, sort and filter. Pure; covered by `tests/web/karma-helpers.test.ts`.
 */
import { esc } from '../ui/index.js';

/** `{ id: name }` from `/api/agents`; anything else gives `{}`. */
export function agentNames(agents) {
  if (!Array.isArray(agents)) return {};
  return Object.fromEntries(agents.map((a) => [String(a.id), a.name || String(a.id)]));
}

const nameOf = (s, names) => String(names?.[s.botId] ?? s.botId ?? '');

export function filterKarma(scores, { query = '', trend = '', names = {} } = {}) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  return (Array.isArray(scores) ? scores : []).filter((s) => {
    if (trend && s.trend !== trend) return false;
    if (q && !`${nameOf(s, names)} ${s.botId}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export const KARMA_SORTS = [
  { id: 'score-desc', label: 'Score (high → low)' },
  { id: 'score-asc', label: 'Score (low → high)' },
  { id: 'name', label: 'Name' },
  { id: 'events', label: 'Recent events' },
];

/** Never mutates. Ties break by name. */
export function sortKarma(scores, sortBy = 'score-desc', names = {}) {
  const byName = (a, b) =>
    nameOf(a, names).toLowerCase().localeCompare(nameOf(b, names).toLowerCase());
  const events = (s) => s.recentEvents?.length || 0;
  const cmp = {
    'score-desc': (a, b) => (b.current ?? 0) - (a.current ?? 0) || byName(a, b),
    'score-asc': (a, b) => (a.current ?? 0) - (b.current ?? 0) || byName(a, b),
    name: byName,
    events: (a, b) => events(b) - events(a) || byName(a, b),
  }[sortBy];
  return [...(Array.isArray(scores) ? scores : [])].sort(cmp ?? (() => 0));
}

function option(value, label, current) {
  return `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
}

export function karmaToolbar({ query = '', sortBy = 'score-desc', trend = '' } = {}) {
  return `<div class="karma-toolbar">
    <input type="search" id="karma-filter-query" data-page-filter placeholder="Filter agents…" aria-label="Filter agents" value="${esc(
      query
    )}">
    <select id="karma-filter-trend" aria-label="Filter by trend">
      ${option('', 'Any trend', trend)}${option('rising', 'Rising', trend)}${option(
        'stable',
        'Stable',
        trend
      )}${option('falling', 'Falling', trend)}
    </select>
    <select id="karma-sort" aria-label="Sort by">
      ${KARMA_SORTS.map((s) => option(s.id, s.label, sortBy)).join('')}
    </select>
  </div>`;
}

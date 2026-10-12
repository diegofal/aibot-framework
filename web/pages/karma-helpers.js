/**
 * Karma list helpers (UX overhaul phase 4): agent names instead of raw
 * botIds, sort and filter; one history row with its "Why this?" fold. Pure; covered by `tests/web/karma-helpers.test.ts`.
 */
import { esc } from '../ui/index.js';
import { ago } from './agent-home-helpers.js';
import { whyPanel } from './why-helpers.js';

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

/** The ledger source as a badge (manual, production, tool, ...). */
export function sourceBadge(source) {
  const cls =
    source === 'manual'
      ? 'badge-disabled'
      : source === 'feedback'
        ? 'eval-badge-approved'
        : source === 'production' || source === 'engagement'
          ? 'badge-ok'
          : source === 'tool'
            ? 'badge-error'
            : 'badge-disabled';
  return `<span class="badge ${cls}">${esc(source)}</span>`;
}

/**
 * One karma history row: delta, source, reason, when, and the shared Why
 * fold (`evt.why`, built by `src/why/builders/karma.ts`) under it.
 */
export function karmaEventRow(evt, { nowMs = Date.now(), botId } = {}) {
  const sign = evt.delta >= 0 ? '+' : '';
  const color = evt.delta > 0 ? 'var(--green)' : evt.delta < 0 ? 'var(--red)' : 'var(--text-dim)';
  return `<div style="display:flex;align-items:center;gap:12px">
      <span style="font-weight:600;color:${color};min-width:48px;font-family:monospace;font-size:14px">${sign}${esc(String(evt.delta))}</span>
      ${sourceBadge(evt.source)}
      <span style="flex:1">${esc(evt.reason)}</span>
      <span class="text-dim text-sm">${esc(ago(evt.timestamp, nowMs))}</span>
    </div>
    ${whyPanel(evt.why, { nowMs, botId })}`;
}

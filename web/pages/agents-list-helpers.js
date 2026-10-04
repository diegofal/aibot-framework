/**
 * Agents list pieces (session S3.5 of docs/plans/jarvis-fleet-plan.md).
 *
 * Pure string helpers for the compact agents table: one primary button per
 * row, everything else behind a row menu, so the row is as tall as its text.
 * `tests/web/agents-list-helpers.test.ts` covers them without a DOM; the page
 * (`agents.js`) keeps the fetching and the event delegation.
 */
import { avatar, dataTable, emptyState, esc, rowMenu } from '../ui/index.js';
import { karmaTone } from './agent-home-helpers.js';

const KARMA_ARROW = { rising: '↑', falling: '↓' };

export function formatTokenCount(n) {
  if (n == null || n === 0) return '--';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function totalTokens(stats) {
  let total = 0;
  for (const u of Object.values(stats?.modelBreakdown ?? {})) {
    total += (Number(u?.promptTokens) || 0) + (Number(u?.completionTokens) || 0);
  }
  return total;
}

/** Stop / Start / Enable & Start — the one button that stays outside the menu. */
export function primaryAction(agent) {
  if (agent?.running) return { action: 'stop', label: 'Stop', danger: true };
  if (agent?.enabled === false) {
    return { action: 'enable-start', label: 'Enable & Start', danger: false };
  }
  return { action: 'start', label: 'Start', danger: false };
}

const PRIMARY_TITLE = {
  stop: 'Stops the agent now. This is transient: with Enabled on, it starts again on the next restart. Turn Enabled off to keep it down.',
  'enable-start':
    'This agent is disabled, so the server refuses a plain Start. This turns Enabled on (saved to bots.json, so it also starts on boot) and starts it now.',
  start: 'Start the agent now.',
};

export function primaryButton(agent) {
  const p = primaryAction(agent);
  return `<button class="btn btn-sm${p.danger ? ' btn-danger' : ''}" data-action="${p.action}" data-id="${esc(
    agent.id
  )}" title="${esc(PRIMARY_TITLE[p.action])}">${esc(p.label)}</button>`;
}

/** Row menu items; falsy entries are skipped by `rowMenu`. */
export function agentMenuItems(agent) {
  const id = agent?.id;
  const running = Boolean(agent?.running);
  const productionsOn = agent?.productions?.enabled !== false;
  return [
    running && { label: 'Run now', action: 'run-loop', id },
    running &&
      (agent.skills ?? []).includes('reflection') && { label: 'Reflect', action: 'reflect', id },
    running && { separator: true },
    { label: 'Open', href: `#/agents/${encodeURIComponent(id)}` },
    { label: 'Edit', action: 'edit', id },
    { label: 'Clone', action: 'clone', id },
    { label: 'Export', action: 'export', id },
    {
      label: productionsOn ? 'Turn productions off' : 'Turn productions on',
      action: 'toggle-productions',
      id,
    },
    { separator: true },
    !running && { label: 'Reset', action: 'reset', id, danger: true },
    { label: 'Delete', action: 'delete', id, danger: true },
  ];
}

export function loopButton(agent) {
  const enabled = agent?.agentLoop?.enabled;
  const label =
    enabled === false ? 'Off' : enabled === true ? 'On' : '<span class="text-dim">Auto</span>';
  const title = enabled == null ? 'Inherit global' : enabled ? 'On' : 'Off';
  return `<button class="btn btn-sm${enabled === false ? ' btn-danger' : ''}" data-action="toggle-loop" data-id="${esc(
    agent.id
  )}" title="${title}">${label}</button>`;
}

/** Same option list and mapping as the bulk editor: 'claude-cli' is a backend offered as a model. */
export function modelSelect(agent, defaults = {}) {
  const effective = agent?.llmBackend === 'claude-cli' ? 'claude-cli' : agent?.model || '';
  const options = (defaults.availableModels ?? [])
    .map((m) => `<option value="${esc(m)}"${m === effective ? ' selected' : ''}>${esc(m)}</option>`)
    .join('');
  return `<select class="inline-model-select" data-agent-id="${esc(agent.id)}" title="Model for this agent">
    <option value=""${!effective ? ' selected' : ''}>Global (${esc(defaults.model ?? '')})</option>
    ${options}
  </select>`;
}

export function karmaCell(karma, botId) {
  const score = karma?.current;
  if (score == null) return '<span class="text-dim">--</span>';
  const arrow = KARMA_ARROW[karma?.trend] ?? '';
  const arrowTone = karma?.trend === 'rising' ? 'ok' : karma?.trend === 'falling' ? 'danger' : '';
  return `<a class="agents-karma agents-karma-${esc(karmaTone(score))}" href="#/insights/karma/${encodeURIComponent(
    botId
  )}" title="Karma ${esc(String(score))}${karma?.trend ? `, ${esc(karma.trend)}` : ''}">${esc(
    String(Math.round(Number(score)))
  )}${arrow ? `<span class="agents-karma-arrow tone-${arrowTone}">${arrow}</span>` : ''}</a>`;
}

/** "357 / 399 calls · 9.9M tokens" plus a fallback chip when there were any. */
export function activityCell(stats) {
  if (!stats || !Number(stats.totalCalls)) return '<span class="text-dim">--</span>';
  const ok = Number(stats.successCount) || 0;
  const total = Number(stats.totalCalls) || 0;
  const tokens = totalTokens(stats);
  const models = Object.keys(stats.modelBreakdown ?? {}).length;
  const fallbacks = Number(stats.fallbackCount) || 0;
  const callTitle = `${ok} successful of ${total} LLM calls`;
  const tokenTitle =
    models > 1
      ? `${tokens.toLocaleString()} tokens across ${models} models`
      : `${tokens.toLocaleString()} tokens`;
  return `<span class="agents-activity">
    <span title="${esc(callTitle)}"><b>${ok}</b><span class="text-dim"> / ${total}</span></span>
    <span class="text-dim">·</span>
    <span title="${esc(tokenTitle)}">${esc(formatTokenCount(tokens))}<span class="text-dim"> tok</span></span>
    ${fallbacks ? `<span class="agents-fallback" title="LLM calls that fell back to another backend">${fallbacks} fallback${fallbacks === 1 ? '' : 's'}</span>` : ''}
  </span>`;
}

function statusCell(agent, executing) {
  if (!agent.running) {
    return agent.enabled === false
      ? '<span class="badge badge-disabled">Disabled</span>'
      : '<span class="badge badge-stopped">Stopped</span>';
  }
  const pulse = executing
    ? ' <span class="processing-pulse" title="Executing a loop cycle"></span>'
    : '';
  return `<span class="badge badge-running">Running</span>${pulse}`;
}

function identityCell(agent, { avatarSrc = (u) => u, executing } = {}) {
  const id = String(agent.id ?? '');
  const src = agent.avatarUrl ? avatarSrc(agent.avatarUrl) : undefined;
  const status = agent.running ? (executing ? 'info' : 'ok') : 'muted';
  return `<a class="agents-identity" href="#/agents/${encodeURIComponent(id)}">
    ${avatar({ seed: id, name: agent.name ?? id, src, size: 30, status })}
    <span class="agents-identity-text">
      <span class="agents-name">${esc(agent.name ?? id)}</span>
      <span class="agents-id text-dim">${esc(id)}</span>
    </span>
  </a>`;
}

/** `{ cells, attrs }` for `dataTable`. */
export function agentRow(
  agent,
  { karma, llmStats, executing = false, defaults = {}, avatarSrc } = {}
) {
  const id = String(agent.id ?? '');
  const classes = [];
  if (!agent.running) classes.push('agents-row-off');
  if (executing) classes.push('agents-row-executing');
  return {
    attrs: { 'data-id': id, class: classes.join(' ') || null },
    cells: [
      `<input type="checkbox" class="bulk-select" data-id="${esc(id)}" aria-label="Select ${esc(agent.name ?? id)}">`,
      identityCell(agent, { avatarSrc, executing }),
      `<label class="toggle" title="Enabled agents start on boot"><input type="checkbox" data-action="toggle-enabled" data-id="${esc(
        id
      )}"${agent.enabled ? ' checked' : ''}><span class="toggle-slider"></span></label>`,
      statusCell(agent, executing),
      modelSelect(agent, defaults),
      loopButton(agent),
      karmaCell(karma, id),
      activityCell(llmStats),
      `<span class="agents-actions">${primaryButton(agent)}${rowMenu(agentMenuItems(agent), {
        label: `Actions for ${agent.name ?? id}`,
      })}</span>`,
    ],
  };
}

export const AGENTS_COLUMNS = [
  { label: '', width: '28px' },
  { label: 'Agent', sort: 'name' },
  'Enabled',
  { label: 'Status', sort: 'status' },
  'Model',
  'Loop',
  { label: 'Karma', align: 'right', sort: 'karma' },
  { label: 'Activity', sort: 'activity' },
  { label: '', align: 'right' },
];

// ── Search, status chips, sorting, bulk (UX overhaul phase 5) ──────────────

export const LIST_PREFS_KEY = 'aibot.agents.list';
export const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'disabled', label: 'Disabled' },
  { id: 'errors', label: 'Errors' },
];
export const SORT_KEYS = ['name', 'status', 'karma', 'activity'];
export const DEFAULT_LIST_PREFS = Object.freeze({
  query: '',
  status: 'all',
  sort: 'name',
  dir: 'asc',
});

const STATUS_RANK = { running: 0, stopped: 1, disabled: 2 };
const ERROR_CHANNEL_STATES = new Set(['revoked', 'error']);

/** 'running' | 'stopped' | 'disabled'. */
export function agentStatus(agent) {
  if (agent?.running) return 'running';
  return agent?.enabled === false ? 'disabled' : 'stopped';
}

/** A broken channel (revoked / error) or any failed LLM call in the stats window. */
export function agentHasError(agent, llmStats) {
  if (ERROR_CHANNEL_STATES.has(agent?.channel?.state)) return true;
  return (Number(llmStats?.failCount) || 0) > 0;
}

function matchesQuery(agent, q) {
  if (!q) return true;
  const hay = [agent?.name, agent?.id, agent?.model, agent?.llmBackend]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

function matchesStatus(agent, status, llmStatsMap) {
  if (!status || status === 'all') return true;
  if (status === 'errors') return agentHasError(agent, llmStatsMap?.[agent?.id]);
  return agentStatus(agent) === status;
}

/** Agents passing the search box and the status chip; order is preserved. */
export function filterAgents(
  agents,
  { query = '', status = 'all' } = {},
  { llmStatsMap = {} } = {}
) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  return (agents ?? []).filter((a) => matchesQuery(a, q) && matchesStatus(a, status, llmStatsMap));
}

/** Chip counts: `{ all, running, stopped, disabled, errors }`. */
export function statusCounts(agents, { llmStatsMap = {} } = {}) {
  const c = { all: 0, running: 0, stopped: 0, disabled: 0, errors: 0 };
  for (const a of agents ?? []) {
    c.all++;
    c[agentStatus(a)]++;
    if (agentHasError(a, llmStatsMap[a?.id])) c.errors++;
  }
  return c;
}

function nameKey(a) {
  return String(a?.name ?? a?.id ?? '').toLowerCase();
}

function timeOf(v) {
  const t = typeof v === 'number' ? v : Date.parse(v ?? '');
  return Number.isFinite(t) ? t : null;
}

/**
 * Sorted copy. `karma` and `activity` (last LLM call) put agents without a
 * value last in both directions; ties fall back to the name.
 */
export function sortAgents(agents, { sort = 'name', dir = 'asc' } = {}, maps = {}) {
  const { karmaMap = {}, llmStatsMap = {} } = maps;
  const sign = dir === 'desc' ? -1 : 1;
  const valueOf = (a) => {
    if (sort === 'status') return STATUS_RANK[agentStatus(a)];
    if (sort === 'karma') {
      const raw = karmaMap[a?.id]?.current;
      const k = Number(raw);
      return raw == null || !Number.isFinite(k) ? null : k;
    }
    if (sort === 'activity') return timeOf(llmStatsMap[a?.id]?.lastCallAt);
    return null;
  };
  return [...(agents ?? [])].sort((x, y) => {
    if (sort === 'name' || !SORT_KEYS.includes(sort)) {
      return nameKey(x).localeCompare(nameKey(y)) * sign;
    }
    const vx = valueOf(x);
    const vy = valueOf(y);
    if (vx == null && vy != null) return 1;
    if (vy == null && vx != null) return -1;
    if (vx != null && vy != null && vx !== vy) return (vx < vy ? -1 : 1) * sign;
    return nameKey(x).localeCompare(nameKey(y));
  });
}

function validPrefs(raw) {
  const p = { ...DEFAULT_LIST_PREFS };
  if (!raw || typeof raw !== 'object') return p;
  if (typeof raw.query === 'string') p.query = raw.query.slice(0, 200);
  if (STATUS_FILTERS.some((f) => f.id === raw.status)) p.status = raw.status;
  if (SORT_KEYS.includes(raw.sort)) p.sort = raw.sort;
  if (raw.dir === 'asc' || raw.dir === 'desc') p.dir = raw.dir;
  return p;
}

/** Saved search/filter/sort for the list (localStorage); defaults on any problem. */
export function readListPrefs(storage) {
  try {
    const raw = storage?.getItem?.(LIST_PREFS_KEY);
    return validPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_LIST_PREFS };
  }
}

export function writeListPrefs(storage, prefs) {
  try {
    storage?.setItem?.(LIST_PREFS_KEY, JSON.stringify(validPrefs(prefs)));
  } catch {
    /* private mode / quota */
  }
}

/** Search box (`data-page-filter`) + status chips. */
export function listFilterBar(prefs = {}, counts = {}) {
  const active = prefs.status || 'all';
  const chips = STATUS_FILTERS.map((f) => {
    const on = f.id === active;
    const n = counts[f.id];
    return `<button type="button" class="agents-chip${on ? ' agents-chip-active' : ''}" data-status-filter="${f.id}" aria-pressed="${on ? 'true' : 'false'}">${esc(
      f.label
    )}${n != null ? ` <span class="agents-chip-n">${esc(String(n))}</span>` : ''}</button>`;
  }).join('');
  return `<div class="agents-filter-bar">
    <input type="search" class="agents-search" id="agents-search" data-page-filter placeholder="Search name, id or model…" aria-label="Search agents" value="${esc(
      prefs.query ?? ''
    )}" autocomplete="off" spellcheck="false">
    <div class="agents-chips" role="group" aria-label="Filter by status">${chips}</div>
  </div>`;
}

function sortableHead(c, sort) {
  const active = sort?.sort === c.sort;
  const desc = active && sort.dir === 'desc';
  const ariaSort = active ? (desc ? 'descending' : 'ascending') : 'none';
  const arrow = active ? (desc ? ' ↓' : ' ↑') : '';
  const what = c.sort === 'activity' ? 'last activity' : String(c.label).toLowerCase();
  const cls = c.align === 'right' ? 'agents-th-sort ui-td-right' : 'agents-th-sort';
  return `<th class="${cls}" aria-sort="${ariaSort}" data-sort="${esc(c.sort)}"><button type="button" class="agents-sort-btn" data-sort-btn="${esc(
    c.sort
  )}" title="Sort by ${esc(what)}">${esc(c.label)}${arrow}</button></th>`;
}

export function agentsTable(
  agents,
  {
    defaults = {},
    karmaMap = {},
    llmStatsMap = {},
    executingMap = {},
    avatarSrc,
    sort = null,
    filtered = false,
  } = {}
) {
  if (!agents || agents.length === 0) {
    if (filtered) {
      return emptyState({
        icon: '⌕',
        title: 'No agents match',
        hint: 'Nothing matches the search and status filter.',
        action:
          '<button type="button" class="btn" data-action="clear-filters">Clear filters</button>',
      });
    }
    return emptyState({
      icon: '◎',
      title: 'No agents yet',
      hint: 'Create one with the wizard or import an export.',
      action: '<a class="btn btn-primary" href="#/agents/new">New agent</a>',
    });
  }
  const columns = AGENTS_COLUMNS.map((c) => (typeof c === 'string' ? { label: c } : c));
  let html = dataTable({
    columns,
    className: 'agents-table',
    id: 'agents-tbody',
    rows: agents.map((a) =>
      agentRow(a, {
        karma: karmaMap[a.id],
        llmStats: llmStatsMap[a.id],
        executing: Boolean(executingMap[a.id]),
        defaults,
        avatarSrc,
      })
    ),
  });
  // Sortable headers and the select-all checkbox are markup the column model
  // cannot express; splice them in.
  for (const c of columns) {
    if (!c.sort) continue;
    const plain = `<th${c.align === 'right' ? ' class="ui-td-right"' : ''}>${esc(c.label)}</th>`;
    html = html.replace(plain, sortableHead(c, sort));
  }
  return html.replace(
    '<th style="width:28px"></th>',
    '<th style="width:28px"><input type="checkbox" id="bulk-select-all" title="Select all"></th>'
  );
}

/**
 * Which selected ids a bulk action applies to; the rest are skipped
 * (already in that state, or no longer in the list).
 */
export function bulkPlan(action, agents, ids) {
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const applies = {
    start: (a) => !a.running,
    stop: (a) => Boolean(a.running),
    enable: (a) => a.enabled === false,
    disable: (a) => a.enabled !== false,
    export: () => true,
    delete: () => true,
  }[action];
  const apply = [];
  const skip = [];
  for (const id of ids ?? []) {
    const a = byId.get(id);
    if (a && applies?.(a)) apply.push(id);
    else skip.push(id);
  }
  return { apply, skip };
}

/** `{ text, tone }` toast for a finished bulk run (`results`: `{ id, ok, error? }`). */
export function bulkSummary(verb, results = [], skipped = 0) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const parts = [];
  if (results.length === 0) parts.push('Nothing to do');
  else if (ok > 0 || failed.length === 0) parts.push(`${verb} ${ok} agent${ok === 1 ? '' : 's'}`);
  if (failed.length) {
    const detail = failed
      .slice(0, 3)
      .map((r) => `${r.id}: ${r.error || 'failed'}`)
      .join('; ');
    parts.push(`${failed.length} failed (${detail}${failed.length > 3 ? '; …' : ''})`);
  }
  if (skipped) parts.push(`${skipped} skipped`);
  const tone =
    results.length === 0 ? 'muted' : failed.length === 0 ? 'ok' : ok === 0 ? 'danger' : 'warn';
  return { text: parts.join(' · '), tone };
}

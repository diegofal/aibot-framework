/**
 * Cron list pieces (session S3.5 of docs/plans/jarvis-fleet-plan.md).
 *
 * Pure string helpers for the compact jobs table: schedules in words (the
 * expression on hover), the agent as a chip instead of a "[botId]" suffix,
 * one Run button per row and the rest behind a row menu, plus an agent
 * filter and a search box. `tests/web/cron-list-helpers.test.ts` covers them
 * without a DOM; `cron.js` keeps fetching, modals and event delegation.
 */
import { badge, dataTable, emptyState, esc, rowMenu } from '../ui/index.js';
import { cronToHuman } from './automations-helpers.js';

/** Sentinel for "jobs that do not belong to one agent" in the agent filter. */
export const FLEET_FILTER = '__fleet__';

const PAYLOAD_KIND = {
  message: { label: 'message', tone: 'muted' },
  instruction: { label: 'instruction', tone: 'ok' },
  skillJob: { label: 'skill', tone: 'accent' },
};

const STATUS_TONE = { ok: 'ok', error: 'danger', skipped: 'warn', running: 'info' };

export function jobAgentId(job) {
  const id = job?.payload?.botId;
  return id ? String(id) : null;
}

function everyWords(ms) {
  const n = Number(ms) || 0;
  const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(1))));
  if (n >= 3_600_000) return `Every ${fmt(n / 3_600_000)}h`;
  if (n >= 60_000) return `Every ${fmt(n / 60_000)}m`;
  return `Every ${fmt(n / 1000)}s`;
}

/** `{ text, detail }`: words for the cell, the raw schedule for the tooltip. */
export function humanSchedule(schedule) {
  const s = schedule ?? {};
  if (s.kind === 'cron') {
    const expr = String(s.expr ?? '').trim();
    return { text: cronToHuman(expr), detail: s.tz ? `${expr} (${s.tz})` : expr };
  }
  if (s.kind === 'every') return { text: everyWords(s.everyMs), detail: `${s.everyMs} ms` };
  if (s.kind === 'at') {
    const d = new Date(s.at);
    const when = Number.isNaN(d.getTime()) ? String(s.at) : d.toLocaleString();
    return { text: `Once at ${when}`, detail: String(s.at) };
  }
  return { text: '?', detail: '' };
}

/** "in 9h" / "5m ago" / '' when unknown. */
export function inWords(ts, nowMs = Date.now()) {
  const t = ts == null ? Number.NaN : typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const diff = t - nowMs;
  const abs = Math.abs(diff);
  let words;
  if (abs < 60_000) words = 'now';
  else if (abs < 3_600_000) words = `${Math.round(abs / 60_000)}m`;
  else if (abs < 172_800_000) words = `${Math.round(abs / 3_600_000)}h`;
  else words = `${Math.round(abs / 86_400_000)}d`;
  if (words === 'now') return diff >= 0 ? 'now' : 'just now';
  return diff > 0 ? `in ${words}` : `${words} ago`;
}

function duration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${(n / 60_000).toFixed(1)}m`;
}

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function payloadCell(payload) {
  const p = payload ?? {};
  const kind = PAYLOAD_KIND[p.kind] ?? { label: String(p.kind ?? '?'), tone: 'muted' };
  const text =
    p.kind === 'skillJob' ? `${p.skillId ?? '?'}/${p.jobId ?? '?'}` : truncate(p.text ?? '', 70);
  return `${badge(kind.label, kind.tone)} <span class="cron-payload-text" title="${esc(
    String(p.text ?? text)
  )}">${esc(text)}</span>`;
}

export function nextRunCell(job, nowMs = Date.now()) {
  if (job?.enabled === false) return '<span class="text-dim">paused</span>';
  const ts = job?.state?.nextRunAtMs;
  if (!ts) return '<span class="text-dim">--</span>';
  return `<span title="${esc(new Date(ts).toLocaleString())}">${esc(inWords(ts, nowMs))}</span>`;
}

export function lastRunCell(job, nowMs = Date.now()) {
  const st = job?.state ?? {};
  if (!st.lastStatus) return '<span class="text-dim">never</span>';
  const tone = STATUS_TONE[st.lastStatus] ?? 'muted';
  const bits = [badge(st.lastStatus, tone)];
  if (st.lastRunAtMs) {
    bits.push(
      `<span class="text-dim" title="${esc(new Date(st.lastRunAtMs).toLocaleString())}">${esc(
        inWords(st.lastRunAtMs, nowMs)
      )}</span>`
    );
  }
  if (st.lastDurationMs != null)
    bits.push(`<span class="text-dim">${esc(duration(st.lastDurationMs))}</span>`);
  const err = st.lastError
    ? `<div class="cron-last-error" title="${esc(truncate(st.lastError, 120))}">${esc(
        truncate(st.lastError, 60)
      )}</div>`
    : '';
  return `<span class="cron-last">${bits.join(' ')}</span>${err}`;
}

/** Removes a trailing "[<botId>]" the skill scheduler appends to job names. */
export function displayName(job) {
  const name = String(job?.name ?? job?.id ?? '');
  const botId = jobAgentId(job);
  if (!botId) return name;
  return name.replace(
    new RegExp(`\\s*\\[${botId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`),
    ''
  );
}

function searchText(job, names) {
  const s = humanSchedule(job?.schedule);
  const p = job?.payload ?? {};
  const botId = jobAgentId(job);
  return [
    job?.name,
    job?.id,
    s.text,
    s.detail,
    p.text,
    p.skillId,
    p.jobId,
    botId,
    botId ? names?.[botId] : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function filterJobs(jobs, { botId = '', query = '', names = {} } = {}) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  return (jobs ?? []).filter((j) => {
    const agent = jobAgentId(j);
    if (botId === FLEET_FILTER && agent) return false;
    if (botId && botId !== FLEET_FILTER && agent !== botId) return false;
    if (q && !searchText(j, names).includes(q)) return false;
    return true;
  });
}

export const CRON_SORTS = [
  { id: 'agent', label: 'Agent' },
  { id: 'name', label: 'Name' },
  { id: 'next', label: 'Next run' },
];

/**
 * `sortBy`: 'agent' (default; fleet-wide jobs first, then by agent name, then
 * by job name), 'name' (job name only) or 'next' (soonest next run first,
 * paused / never-scheduled jobs last). Never mutates.
 */
export function sortJobs(jobs, names = {}, sortBy = 'agent') {
  const agentKey = (j) => {
    const id = jobAgentId(j);
    return id ? `1${String(names?.[id] ?? id).toLowerCase()}` : '0';
  };
  const nextKey = (j) => {
    const t = j?.enabled === false ? null : j?.state?.nextRunAtMs;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return [...(jobs ?? [])]
    .map((j, i) => ({ j, i, a: agentKey(j), n: displayName(j).toLowerCase(), t: nextKey(j) }))
    .sort((x, y) => {
      if (sortBy === 'next' && x.t !== y.t) return x.t < y.t ? -1 : 1;
      if (sortBy === 'agent' && x.a !== y.a) return x.a < y.a ? -1 : 1;
      if (x.n !== y.n) return x.n < y.n ? -1 : 1;
      return x.i - y.i;
    })
    .map((x) => x.j);
}

export function jobMenuItems(job) {
  const id = job?.id;
  return [
    { label: 'Edit', action: 'edit', id },
    { label: 'Run logs', action: 'logs', id },
    { label: 'Open', href: `#/automations/cron/${encodeURIComponent(id)}` },
    { separator: true },
    { label: 'Delete', action: 'delete', id, danger: true },
  ];
}

/** `{ cells, attrs }` for `dataTable`. */
export function jobRow(job, { names = {}, nowMs = Date.now() } = {}) {
  const id = String(job?.id ?? '');
  const botId = jobAgentId(job);
  const agentName = botId ? (names[botId] ?? botId) : null;
  const sched = humanSchedule(job?.schedule);
  const classes = [];
  if (job?.enabled === false) classes.push('cron-row-off');
  if (job?.state?.lastStatus === 'error') classes.push('cron-row-error');
  const agentChip = botId
    ? `<a class="cron-agent" href="#/agents/${encodeURIComponent(botId)}">${esc(agentName)}</a>`
    : '<span class="cron-agent cron-agent-fleet">fleet</span>';
  return {
    attrs: { 'data-id': id, class: classes.join(' ') || null },
    cells: [
      `<div class="cron-name"><a href="#/automations/cron/${encodeURIComponent(id)}">${esc(
        displayName(job)
      )}</a>${agentChip}</div>`,
      `<span class="cron-when" title="${esc(sched.detail)}">${esc(sched.text)}</span>`,
      payloadCell(job?.payload),
      `<label class="toggle" title="${job?.enabled === false ? 'Paused' : 'Enabled'}"><input type="checkbox" data-action="toggle" data-id="${esc(
        id
      )}"${job?.enabled === false ? '' : ' checked'}><span class="toggle-slider"></span></label>`,
      nextRunCell(job, nowMs),
      lastRunCell(job, nowMs),
      `<span class="cron-actions"><button class="btn btn-sm" data-action="run" data-id="${esc(
        id
      )}" title="Run this job now">Run</button>${rowMenu(jobMenuItems(job), {
        label: `Actions for ${displayName(job)}`,
      })}</span>`,
    ],
  };
}

export const CRON_COLUMNS = [
  'Job',
  'When',
  'Does',
  'On',
  'Next',
  'Last run',
  { label: '', align: 'right' },
];

export function cronTable(
  jobs,
  {
    names = {},
    nowMs = Date.now(),
    filtered = false,
    sortBy = 'agent',
    selectable = false,
    selected = new Set(),
  } = {}
) {
  const list = jobs ?? [];
  if (list.length === 0) {
    return filtered
      ? emptyState({
          icon: '⌕',
          title: 'No jobs match',
          hint: 'Clear the filter to see every job.',
        })
      : emptyState({
          icon: '◷',
          title: 'No cron jobs yet',
          hint: 'Tell an agent what to do and when in the box above.',
        });
  }
  const rows = sortJobs(list, names, sortBy).map((j) => {
    const row = jobRow(j, { names, nowMs });
    if (!selectable) return row;
    const id = String(j?.id ?? '');
    const box = `<input type="checkbox" class="cron-select" data-select="${esc(id)}"${
      selected.has(id) ? ' checked' : ''
    } aria-label="Select ${esc(displayName(j))}">`;
    return { ...row, cells: [box, ...row.cells] };
  });
  return dataTable({
    columns: selectable ? [{ label: '', width: '28px' }, ...CRON_COLUMNS] : CRON_COLUMNS,
    className: 'cron-table',
    id: 'cron-tbody',
    rows,
  });
}

/** Agent filter (with counts) + search box. */
export function cronToolbar({
  agents = [],
  jobs = [],
  botId = '',
  query = '',
  sortBy = 'agent',
} = {}) {
  const counts = new Map();
  let fleet = 0;
  for (const j of jobs) {
    const id = jobAgentId(j);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    else fleet++;
  }
  const known = new Set(agents.map((a) => String(a.id)));
  const options = agents.map(
    (a) =>
      `<option value="${esc(a.id)}"${String(a.id) === botId ? ' selected' : ''}>${esc(
        a.name ?? a.id
      )} (${counts.get(String(a.id)) ?? 0})</option>`
  );
  // Jobs pointing at an agent that no longer exists still deserve a filter entry.
  for (const [id, n] of counts) {
    if (!known.has(id)) {
      options.push(
        `<option value="${esc(id)}"${id === botId ? ' selected' : ''}>${esc(id)} (${n})</option>`
      );
    }
  }
  if (fleet > 0) {
    options.push(
      `<option value="${FLEET_FILTER}"${botId === FLEET_FILTER ? ' selected' : ''}>Fleet-wide (${fleet})</option>`
    );
  }
  return `<div class="cron-toolbar">
    <select id="cron-filter-agent" class="cron-filter" aria-label="Filter by agent">
      <option value="">All agents (${jobs.length})</option>
      ${options.join('')}
    </select>
    <input id="cron-filter-query" class="cron-filter cron-filter-query" type="search" data-page-filter placeholder="Filter jobs…" value="${esc(
      query
    )}" aria-label="Filter jobs">
    <select id="cron-sort" class="cron-filter" aria-label="Sort jobs">
      ${CRON_SORTS.map(
        (o) =>
          `<option value="${o.id}"${o.id === sortBy ? ' selected' : ''}>Sort: ${esc(o.label)}</option>`
      ).join('')}
    </select>
    <label class="cron-select-all"><input type="checkbox" id="cron-select-all" aria-label="Select all visible jobs"> All</label>
  </div>`;
}

/** Bulk action bar for the selected jobs; '' when nothing is selected. */
export function cronBulkBar(count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return `<div class="ops-bulk-bar" role="toolbar" aria-label="Bulk actions">
    <span class="ops-bulk-count">${n} selected</span>
    <button class="btn btn-sm" data-bulk="pause">Pause</button>
    <button class="btn btn-sm" data-bulk="resume">Resume</button>
    <button class="btn btn-sm" data-bulk="run">Run</button>
    <button class="btn btn-sm btn-danger" data-bulk="delete">Delete</button>
    <button class="btn btn-sm" data-bulk="clear">Clear</button>
  </div>`;
}

/**
 * The selected jobs an action would actually change: pause skips jobs that
 * are already paused, resume skips running ones; run and delete take all.
 */
export function bulkTargets(jobs, ids, action) {
  const sel = (jobs ?? []).filter((j) => ids?.has(String(j?.id)));
  if (action === 'pause') return sel.filter((j) => j.enabled !== false);
  if (action === 'resume') return sel.filter((j) => j.enabled === false);
  return sel;
}

/** `{ list, error }` from an `api()` response that should have been an array. */
export function apiList(res) {
  if (Array.isArray(res)) return { list: res, error: null };
  const error =
    res && typeof res === 'object' && res.error ? String(res.error) : 'Unexpected response';
  return { list: [], error };
}

/** Error panel with a Retry button (`data-action="retry"`). */
export function cronErrorState(message, title = 'Could not load cron jobs') {
  return emptyState({
    icon: '!',
    title,
    hint: String(message ?? ''),
    action: '<button class="btn btn-sm" data-action="retry">Retry</button>',
    class: 'ops-error-state',
  });
}

/**
 * Toast for `POST /api/cron/rerun-failed` (`{ attempted, results: [{ ran }] }`).
 * Shared by the Cron page's "Re-run failed" button and the palette action.
 */
export function rerunSummary(res) {
  if (!res || res.error) {
    return { text: `Re-run failed: ${res?.error ?? 'no response'}`, tone: 'danger' };
  }
  const results = Array.isArray(res.results) ? res.results : [];
  const succeeded = results.filter((r) => r?.ran).length;
  const attempted = Number(res.attempted) || 0;
  return { text: `Re-ran ${succeeded}/${attempted}`, tone: succeeded ? 'ok' : 'danger' };
}

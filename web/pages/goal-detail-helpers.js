/**
 * Goal detail drawer (Agent Home → click a goal card). Pure render helpers
 * over `GET /api/agents/:id/goals/detail` (`GoalDetailResponse` in
 * src/stats/types.ts); agent-home.js opens the sheet and fetches.
 */
import { badge, esc } from '../ui/index.js';
import { ago } from './agent-home-helpers.js';
import { prodHash } from './productions-helpers.js';

const BUCKET_LABEL = {
  todo: ['To do', 'muted'],
  inProgress: ['In progress', 'accent'],
  blocked: ['Blocked', 'danger'],
  done: ['Done', 'ok'],
};

const ORIGIN_LABEL = {
  operator: 'Set by you',
  agent: 'Set by the agent',
  strategist: 'Set by the strategist',
  reflection: 'Set by reflection',
  curiosity: 'Set by curiosity',
  preset: 'From a preset',
  unknown: 'Origin unknown',
};

const ATTRIBUTION_LABEL = { exact: 'exact', inferred: 'inferred', weak: 'likely' };

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

/** API URL for one goal's detail: by id when the goal has one, else by exact title. */
export function goalDetailUrl(botId, { id, title }) {
  const base = `/api/agents/${encodeURIComponent(botId)}/goals/detail`;
  return id
    ? `${base}?id=${encodeURIComponent(id)}`
    : `${base}?title=${encodeURIComponent(title ?? '')}`;
}

function when(value, nowMs) {
  if (!value) return '<span class="gd-dim">—</span>';
  // Date-only values (GOALS.md `created: 2026-10-04`) have no meaningful hour.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return esc(value);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return esc(value);
  const abs = new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${esc(abs)} <span class="gd-dim">· ${esc(ago(t, nowMs))}</span>`;
}

function duration(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function header(goal, nowMs) {
  const [label, tone] = BUCKET_LABEL[goal.bucket] ?? BUCKET_LABEL.todo;
  const pri = goal.priority ? `<span class="gd-chip">${esc(goal.priority)}</span>` : '';
  const origin = ORIGIN_LABEL[goal.origin] ?? ORIGIN_LABEL.unknown;
  const originChip = `<span class="gd-chip${goal.origin === 'operator' ? ' gd-chip-you' : ''}" title="${esc(goal.source ?? '')}">${esc(origin)}${goal.originDate ? ` · ${esc(goal.originDate)}` : ''}</span>`;
  const dates = [
    ['Created', goal.created],
    ['Started', goal.started],
    ['Updated', goal.updated],
    ['Done', goal.completed],
  ]
    .filter(([, v], i) => v || i < 2)
    .map(([k, v]) => `<div class="gd-date"><dt>${k}</dt><dd>${when(v, nowMs)}</dd></div>`)
    .join('');
  return `<div class="gd-head">
    <h2 class="gd-title" id="gd-title">${esc(goal.text)}</h2>
    <div class="gd-chips">${badge(label, tone, { dot: true })}${pri}${originChip}</div>
    <dl class="gd-dates">${dates}</dl>
  </div>`;
}

function section(title, body, extra = '') {
  return `<section class="gd-section"><div class="gd-label">${title}${extra}</div>${body}</section>`;
}

function totals(t) {
  const items = [
    [fmt(t.cycles), 'cycles', t.exactCycles ? `${t.exactCycles} exact` : 'all inferred'],
    [fmt(t.llmCalls), 'LLM calls', null],
    [fmt(t.tokens), 'tokens', null],
    [fmt(t.toolCalls), 'tool calls', t.toolFailures ? `${t.toolFailures} failed` : null],
    [fmt(t.files), 'files', null],
    [fmt(t.asks), 'questions', null],
  ];
  return `<div class="gd-stats">${items
    .map(
      ([v, k, sub]) =>
        `<div class="gd-stat"><div class="gd-stat-v">${v}</div><div class="gd-stat-k">${k}${sub ? ` <span class="gd-dim">· ${esc(sub)}</span>` : ''}</div></div>`
    )
    .join('')}</div>`;
}

function timeline(events, nowMs) {
  if (!events.length) return '<div class="gd-empty">No recorded changes yet.</div>';
  return `<ol class="gd-tl">${events
    .map((e) => {
      const change =
        e.from || e.to ? `${esc(e.from ?? '')}${e.from ? ' → ' : ''}${esc(e.to ?? '')}` : '';
      return `<li class="gd-tl-item${e.inferred ? ' inferred' : ''}"${e.inferred ? ' title="Reconstructed from a manage_goals call"' : ''}>
        <div class="gd-tl-op">${esc(e.op)}${change ? ` <span class="gd-tl-change">${change}</span>` : ''}${e.actor ? ` <span class="gd-dim">by ${esc(e.actor)}</span>` : ''}</div>
        <div class="gd-tl-when">${when(e.ts, nowMs)}</div>
        ${e.note ? `<div class="gd-tl-note">${esc(e.note)}</div>` : ''}
      </li>`;
    })
    .join('')}</ol>`;
}

function rows(title, list) {
  if (!list.length) return '';
  return `<div class="gd-sub"><div class="gd-sub-title">${title} <span class="gd-dim">${list.length}</span></div>${list.join('')}</div>`;
}

function cycleBlock(c, botId, nowMs, open) {
  const attr = ATTRIBUTION_LABEL[c.attribution] ?? c.attribution;
  const summary = c.planSummary || c.focus || 'No plan summary recorded';
  const tokens = c.llmCalls.reduce((s, l) => s + l.promptTokens + l.completionTokens, 0);
  const counts = [
    `${c.llmCalls.length} LLM`,
    `${c.toolCalls.length} tools`,
    c.productions.length ? `${c.productions.length} files` : '',
    c.asks.length ? `${c.asks.length} asks` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const llm = c.llmCalls.map(
    (l) => `<div class="gd-row${l.ok ? '' : ' bad'}">
      <span class="gd-row-name">${esc(l.caller)}</span>
      <span class="gd-dim">${esc(l.model || l.backend)}</span>
      <span class="gd-row-meta">${fmt(l.promptTokens + l.completionTokens)} tok · ${duration(l.durationMs)}</span>
      ${l.error ? `<div class="gd-row-err">${esc(l.error)}</div>` : ''}
    </div>`
  );
  const tools = c.toolCalls.map(
    (t) => `<div class="gd-row${t.ok ? '' : ' bad'}" title="${esc(t.args)}">
      <span class="gd-row-name">${esc(t.name)}</span>
      ${t.failureKind ? `<span class="gd-chip">${esc(t.failureKind)}</span>` : ''}
      <span class="gd-row-meta gd-clip">${esc(t.ok ? t.args : t.result)}</span>
    </div>`
  );
  const files = c.productions.map(
    (p) => `<div class="gd-row">
      <a class="gd-row-name" href="${prodHash({ botId, file: p.path, single: true })}">${esc(p.path)}</a>
      <span class="gd-dim">${esc(p.action)}</span>
      ${p.review ? `<span class="gd-chip gd-review-${esc(p.review)}">${esc(p.review)}</span>` : ''}
    </div>`
  );
  const asks = c.asks.map(
    (a) =>
      `<div class="gd-row"><span class="gd-row-name gd-clip">${esc(a.title)}</span>${a.status ? `<span class="gd-dim">${esc(a.status)}</span>` : ''}</div>`
  );
  const karma = c.karma.map(
    (k) =>
      `<div class="gd-row"><span class="gd-row-name ${k.delta >= 0 ? 'gd-pos' : 'gd-neg'}">${k.delta >= 0 ? '+' : ''}${esc(String(k.delta))}</span><span class="gd-row-meta gd-clip">${esc(k.reason)}</span></div>`
  );
  const body =
    rows('LLM calls', llm) +
    rows('Tool calls', tools) +
    rows('Files', files) +
    rows('Questions', asks) +
    rows('Karma', karma);
  return `<details class="gd-cycle gd-attr-${esc(c.attribution)}"${open ? ' open' : ''}>
    <summary>
      <span class="gd-attr gd-attr-${esc(c.attribution)}" title="${esc(c.reason)}">${esc(attr)}</span>
      <span class="gd-cycle-when">${when(c.startedAt, nowMs)} <span class="gd-dim">· ${duration(c.durationMs)}${tokens ? ` · ${fmt(tokens)} tok` : ''}</span></span>
      <span class="gd-cycle-sum">${esc(summary)}</span>
      <span class="gd-cycle-counts">${counts}</span>
    </summary>
    <div class="gd-cycle-body">${body || '<div class="gd-empty">No rows found for this cycle.</div>'}</div>
  </details>`;
}

/** Whole drawer body for one goal. */
export function goalDetailBody(detail, botId, nowMs = Date.now()) {
  const g = detail.goal;
  const notes = [g.notes, g.outcome ? `Outcome: ${g.outcome}` : '']
    .filter(Boolean)
    .map((n) => `<p>${esc(n)}</p>`)
    .join('');
  const cycles = detail.cycles.length
    ? detail.cycles.map((c, i) => cycleBlock(c, botId, nowMs, i === 0)).join('')
    : `<div class="gd-empty">No work linked to this goal in the last ${esc(String(detail.days))} days.</div>`;
  return `<div class="gd" aria-labelledby="gd-title">
    ${header(g, nowMs)}
    ${notes ? section('Notes', `<div class="gd-notes">${notes}</div>`) : ''}
    ${totals(detail.totals)}
    ${section('Status history', timeline(detail.timeline, nowMs))}
    ${section(
      'Work on this goal',
      `<div class="gd-track">${esc(detail.tracking.note)}</div>${cycles}`,
      ` <span class="gd-dim">last ${esc(String(detail.days))} days</span>`
    )}
  </div>`;
}

export function goalDetailLoading() {
  return '<div class="gd"><div class="gd-empty">Loading goal…</div></div>';
}

export function goalDetailError(message) {
  return `<div class="gd"><div class="gd-empty">Could not load this goal: ${esc(message)}</div></div>`;
}

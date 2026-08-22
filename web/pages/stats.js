import {
  loadRoutines,
  renderHistoryTable,
  renderHygienePanel,
  renderHygieneRun,
  runAndRender,
} from './hygiene.js';
import { api, escapeHtml } from './shared.js';
import {
  STATS_WINDOWS,
  answerRate,
  barHeights,
  channelStateClass,
  compareBy,
  driftVectorData,
  failRateClass,
  formatBytes,
  formatDuration,
  formatNumber,
  formatPct,
  formatTokens,
  goalsBoard,
  isStaleContact,
  normalizeWindow,
  postureClass,
  relativeTime,
  sparklinePoints,
  traitDeltas,
  windowQuery,
} from './stats-helpers.js';

const WINDOW_KEY = 'stats.window';

function getWindow() {
  try {
    return normalizeWindow(localStorage.getItem(WINDOW_KEY));
  } catch {
    return normalizeWindow();
  }
}

function setWindow(w) {
  try {
    localStorage.setItem(WINDOW_KEY, normalizeWindow(w));
  } catch {
    /* ignore */
  }
}

const TABS = [
  { id: 'fleet', label: 'Fleet', href: '#/stats' },
  { id: 'behaviour', label: 'Behaviour', href: '#/stats/behaviour' },
  { id: 'infra', label: 'Infra', href: '#/stats/infra' },
  { id: 'hygiene', label: 'Hygiene', href: '#/stats/hygiene' },
];

/**
 * Page chrome shared by all stats views: title, tabs, optional window selector.
 * Returns the body container. `onWindowChange` re-renders the view.
 */
function shell(el, activeTab, { withWindow = false, onWindowChange, subtitle } = {}) {
  const w = getWindow();
  el.innerHTML = `
    <div class="flex-between mb-16 stats-header">
      <div class="page-title" style="margin-bottom:0">Stats &amp; Behaviour${subtitle ? ` <span class="count">${subtitle}</span>` : ''}</div>
      ${
        withWindow
          ? `<div class="stats-toolbar">
              <label class="text-dim text-sm" for="stats-window">Window</label>
              <select id="stats-window" class="stats-select">${STATS_WINDOWS.map(
                (x) => `<option value="${x}"${x === w ? ' selected' : ''}>${x}</option>`
              ).join('')}</select>
            </div>`
          : ''
      }
    </div>
    <div class="stats-tabs">${TABS.map(
      (t) =>
        `<a class="stats-tab${t.id === activeTab ? ' active' : ''}" href="${t.href}">${t.label}</a>`
    ).join('')}</div>
    <div id="stats-body"><p class="text-dim">Loading...</p></div>`;
  if (withWindow) {
    el.querySelector('#stats-window').addEventListener('change', (e) => {
      setWindow(e.target.value);
      if (onWindowChange) onWindowChange();
    });
  }
  return el.querySelector('#stats-body');
}

function errorState(body, res, what) {
  body.innerHTML = `<div class="detail-card"><p class="text-dim">${what} unavailable${
    res?.error ? `: ${escapeHtml(res.error)}` : ''
  }</p></div>`;
}

function pill(text, cls, title) {
  return `<span class="badge ${cls}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text)}</span>`;
}

function channelPill(channel) {
  if (!channel) return pill('unknown', 'badge-disabled');
  if (channel.kind === 'headless') return pill('headless', 'badge-disabled');
  return pill(`${channel.kind} · ${channel.state}`, channelStateClass(channel.state));
}

function posturePill(posture) {
  return pill(posture || 'unknown', postureClass(posture));
}

function inlineBar(rate, label) {
  const pct = Math.min(100, Math.round((rate || 0) * 100));
  const cls = failRateClass(rate);
  return `<span class="stats-inline-bar" title="${escapeHtml(label || formatPct(rate))}"><span class="stats-inline-bar-fill ${cls}" style="width:${pct}%"></span></span>`;
}

function delta(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n === 0) return '<span class="text-dim">±0</span>';
  const cls = n > 0 ? 'stats-delta-pos' : 'stats-delta-neg';
  return `<span class="${cls}">${n > 0 ? '+' : ''}${Math.round(n * 100) / 100}</span>`;
}

function flag(count, label) {
  if (!count) return '';
  return `<span class="stats-flag" title="${escapeHtml(label)}">${formatNumber(count)} ${escapeHtml(label)}</span>`;
}

function kpi(label, value, { sub, state } = {}) {
  return `<div class="stats-kpi${state ? ` is-${state}` : ''}">
    <div class="stats-kpi-value">${value}</div>
    <div class="stats-kpi-label">${escapeHtml(label)}</div>
    ${sub ? `<div class="stats-kpi-sub">${sub}</div>` : ''}
  </div>`;
}

function section(title, bodyHtml, extra = '') {
  return `<div class="detail-card"><div class="stats-section-title">${title}${extra}</div>${bodyHtml}</div>`;
}

/* ========================= Fleet ========================= */

const FLEET_COLUMNS = [
  { key: 'name', label: 'Bot', get: (b) => b.name || b.botId },
  { key: 'channel', label: 'Channel', get: (b) => `${b.channel?.kind}:${b.channel?.state}` },
  { key: 'backend', label: 'Backend · model', get: (b) => `${b.backend}/${b.model}` },
  { key: 'cadence', label: 'Cadence · next', get: (b) => Date.parse(b.loop?.nextRunAt) || null },
  { key: 'posture', label: 'Posture', get: (b) => b.posture },
  { key: 'llm', label: 'LLM calls · fail', get: (b) => b.llm?.calls, num: true },
  { key: 'tools', label: 'Tools', get: (b) => b.tools?.calls, num: true },
  { key: 'files', label: 'Files act · unrev', get: (b) => b.output?.unreviewed, num: true },
  { key: 'asks', label: 'Asks sent · ans', get: (b) => b.engagement?.asksSent, num: true },
  { key: 'goals', label: 'Goals', get: (b) => b.goals?.active, num: true },
  { key: 'karma', label: 'Karma', get: (b) => b.karma?.score, num: true },
  { key: 'contact', label: 'Last human', get: (b) => Date.parse(b.lastHumanContactAt) || null },
];

let fleetSort = { key: 'name', dir: 1 };

function fleetRow(b) {
  const id = encodeURIComponent(b.botId);
  const llmFail = b.llm?.failRate ?? answerRate(b.llm?.failed, b.llm?.calls);
  const stale = isStaleContact(b.lastHumanContactAt);
  const nextRun = b.loop?.nextRunAt ? relativeTime(b.loop.nextRunAt) : '--';
  const loopErr = b.loop?.lastError
    ? ` <span class="stats-bad" title="${escapeHtml(b.loop.lastError)}">!</span>`
    : '';
  const goalFlags = [
    flag(b.goals?.archivedInActive, 'archived'),
    flag(b.goals?.duplicates, 'dup'),
    flag(b.goals?.oversizedNotes, 'oversized'),
  ].join('');
  return `<tr>
    <td><a href="#/stats/bot/${id}">${escapeHtml(b.name || b.botId)}</a>${
      b.enabled === false ? ' <span class="badge badge-disabled">off</span>' : ''
    }<div class="stats-muted-id">${escapeHtml(b.botId)}</div></td>
    <td>${channelPill(b.channel)}</td>
    <td class="text-sm">${escapeHtml(b.backend || '--')}<span class="text-dim"> · </span>${escapeHtml(b.model || '--')}</td>
    <td class="text-sm">${escapeHtml(b.loop?.cadence || b.loop?.mode || '--')}<div class="text-dim">${nextRun}${loopErr}</div></td>
    <td>${posturePill(b.posture)}</td>
    <td class="num">${formatNumber(b.llm?.calls)} <span class="text-dim">${formatPct(llmFail)}</span>${inlineBar(
      llmFail,
      `${formatNumber(b.llm?.failed)} failed of ${formatNumber(b.llm?.calls)}`
    )}</td>
    <td class="num">${formatNumber(b.tools?.calls)}${
      b.tools?.failed ? ` <span class="stats-bad">${formatNumber(b.tools.failed)}</span>` : ''
    }${b.tools?.loopBreaks ? flag(b.tools.loopBreaks, 'loops') : ''}</td>
    <td class="num">${formatNumber(b.output?.filesActive)} <span class="text-dim">·</span> <span class="${
      b.output?.unreviewed ? 'stats-warn' : 'text-dim'
    }">${formatNumber(b.output?.unreviewed)}</span></td>
    <td class="num">${formatNumber(b.engagement?.asksSent)} <span class="text-dim">·</span> ${formatNumber(
      b.engagement?.asksAnswered
    )}${b.engagement?.asksPending ? flag(b.engagement.asksPending, 'pending') : ''}</td>
    <td class="num">${formatNumber(b.goals?.active)}${goalFlags}</td>
    <td class="num">${b.karma?.score != null ? formatNumber(b.karma.score) : '--'} ${delta(b.karma?.delta)}</td>
    <td class="${stale ? 'stats-stale' : 'text-dim'}">${relativeTime(b.lastHumanContactAt)}</td>
  </tr>`;
}

function renderFleetTable(container, bots) {
  const col = FLEET_COLUMNS.find((c) => c.key === fleetSort.key) || FLEET_COLUMNS[0];
  const sorted = [...bots].sort(compareBy(col.get, fleetSort.dir));
  container.innerHTML = `<table class="stats-table">
    <thead><tr>${FLEET_COLUMNS.map(
      (c) =>
        `<th class="sortable${c.num ? ' num' : ''}${
          c.key === fleetSort.key ? (fleetSort.dir === 1 ? ' sorted-asc' : ' sorted-desc') : ''
        }" data-key="${c.key}">${c.label}</th>`
    ).join('')}</tr></thead>
    <tbody>${sorted.map(fleetRow).join('')}</tbody>
  </table>`;
  container.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      fleetSort = key === fleetSort.key ? { key, dir: -fleetSort.dir } : { key, dir: 1 };
      renderFleetTable(container, bots);
    });
  });
}

export async function renderStats(el) {
  const body = shell(el, 'fleet', { withWindow: true, onWindowChange: () => renderStats(el) });
  const w = getWindow();
  const data = await api(`/api/stats/fleet${windowQuery(w)}`);
  if (!data || data.error || !Array.isArray(data.bots))
    return errorState(body, data, 'Fleet stats');

  const t = data.totals || {};
  const llmFail = answerRate(t.llmFailed, t.llmCalls);
  const toolFail = answerRate(t.toolFailed, t.toolCalls);
  const kpis = [
    kpi('LLM fail', formatPct(llmFail), {
      sub: `${formatNumber(t.llmFailed)} / ${formatNumber(t.llmCalls)} calls`,
      state: failRateClass(llmFail) === 'ok' ? null : failRateClass(llmFail),
    }),
    kpi('Tool calls', formatNumber(t.toolCalls), {
      sub: t.toolFailed
        ? `<span class="stats-bad">${formatNumber(t.toolFailed)} failed (${formatPct(toolFail)})</span>`
        : 'no failures',
      state: failRateClass(toolFail) === 'ok' ? null : failRateClass(toolFail),
    }),
    kpi('Unreviewed files', formatNumber(t.unreviewed), {
      sub: `${formatNumber(t.filesActive)} active`,
      state: t.unreviewed > 0 ? 'warn' : null,
    }),
    kpi('Asks pending', formatNumber(t.asksPending), { state: t.asksPending > 0 ? 'warn' : null }),
    kpi('Cycles', formatNumber(t.cycles)),
    kpi('Prompt tokens', formatTokens(t.promptTokens), {
      sub: `${formatTokens(t.completionTokens)} completion`,
    }),
  ].join('');

  body.innerHTML = `
    <div class="stats-kpis">${kpis}</div>
    <div class="detail-card stats-table-card">
      <div class="stats-section-title">Bots <span class="count">${data.bots.length} · ${escapeHtml(data.window || w)} · generated ${relativeTime(data.generatedAt)}</span></div>
      <div id="stats-fleet-table" class="stats-table-wrap"></div>
    </div>`;
  if (data.bots.length === 0) {
    body.querySelector('#stats-fleet-table').innerHTML =
      '<p class="text-dim text-sm">No bots configured.</p>';
    return;
  }
  renderFleetTable(body.querySelector('#stats-fleet-table'), data.bots);
}

/* ========================= Bot drill-down ========================= */

function dailyChart(series, { valueKey = 'calls', failKey = 'failed', label }) {
  const rows = Array.isArray(series) ? series : [];
  if (rows.length === 0)
    return `<div class="stats-chart-empty text-dim text-sm">No ${escapeHtml(label)} in window.</div>`;
  const values = rows.map((r) => r[valueKey] || 0);
  const heights = barHeights(values);
  const max = Math.max(...values);
  const cols = rows
    .map((r, i) => {
      const total = r[valueKey] || 0;
      const failed = r[failKey] || 0;
      const failPct = total > 0 ? Math.round((failed / total) * 100) : 0;
      const title = `${r.date}: ${formatNumber(total)} ${label}${failed ? `, ${formatNumber(failed)} failed` : ''}${
        r.promptTokens ? `, ${formatTokens(r.promptTokens)} prompt tokens` : ''
      }`;
      return `<div class="stats-chart-col" title="${escapeHtml(title)}">
        <div class="stats-chart-bar" style="height:${heights[i]}%">${
          failed ? `<div class="stats-chart-fail" style="height:${failPct}%"></div>` : ''
        }</div>
      </div>`;
    })
    .join('');
  const first = rows[0].date;
  const last = rows[rows.length - 1].date;
  return `<div class="stats-chart">${cols}</div>
    <div class="stats-chart-axis text-dim"><span>${escapeHtml(String(first))}</span><span>max ${formatNumber(max)}</span><span>${escapeHtml(String(last))}</span></div>`;
}

function traitsPanel(traits) {
  const rows = traitDeltas(traits?.current, traits?.baseline);
  if (rows.length === 0) return '<p class="text-dim text-sm">No trait data.</p>';
  const allVals = rows.flatMap((r) => [r.current, r.baseline]).filter((v) => v != null);
  const max = Math.max(1, ...allVals);
  return `<div class="stats-traits">${rows
    .map((r) => {
      const cur = r.current != null ? Math.round((r.current / max) * 100) : 0;
      const base = r.baseline != null ? Math.round((r.baseline / max) * 100) : null;
      return `<div class="stats-trait-row" title="${escapeHtml(
        `${r.trait}: current ${r.current ?? '--'}, baseline ${r.baseline ?? '--'}`
      )}">
        <span class="stats-trait-name">${escapeHtml(r.trait)}</span>
        <span class="stats-trait-track">
          <span class="stats-trait-cur" style="width:${cur}%"></span>
          ${base != null ? `<span class="stats-trait-base" style="left:${base}%"></span>` : ''}
        </span>
        <span class="stats-trait-val num">${r.current != null ? r.current : '--'}</span>
        <span class="stats-trait-delta num">${r.delta != null ? delta(r.delta) : ''}</span>
      </div>`;
    })
    .join('')}</div>
    <div class="text-dim text-sm" style="margin-top:6px">bar = current · tick = baseline${
      traits?.adjustments != null ? ` · ${formatNumber(traits.adjustments)} adjustments` : ''
    }</div>`;
}


function cyclesList(cycles) {
  const list = Array.isArray(cycles) ? cycles : [];
  if (list.length === 0) return '<p class="text-dim text-sm">No recent cycles.</p>';
  return list
    .map(
      (c) => `<div class="stats-cycle">
      <div class="stats-cycle-head"><span class="stats-chip">#${escapeHtml(String(c.cycle ?? '?'))}</span> <span class="text-dim text-sm">${relativeTime(c.timestamp)}</span></div>
      <div class="stats-cycle-plan">${escapeHtml(c.planSummary || '(no plan summary)')}</div>
      ${
        Array.isArray(c.tools) && c.tools.length
          ? `<div class="stats-cycle-tools">${c.tools.map((t) => `<span class="stats-chip mono">${escapeHtml(String(t))}</span>`).join('')}</div>`
          : ''
      }
    </div>`
    )
    .join('');
}

const INBOX_BADGE = {
  pending: 'badge-inbox-pending',
  answered: 'badge-inbox-answered',
  dismissed: 'badge-inbox-dismissed',
  timed_out: 'badge-inbox-timed-out',
};

function asksList(asks, botId) {
  const list = Array.isArray(asks) ? asks : [];
  if (list.length === 0) return '<p class="text-dim text-sm">No asks in window.</p>';
  return `<table class="stats-table"><thead><tr><th>Question</th><th>Status</th><th class="num">Chars</th><th>Asked</th><th>Answered</th></tr></thead>
    <tbody>${list
      .map(
        (a) => `<tr>
        <td><a href="#/inbox/${encodeURIComponent(botId)}/${encodeURIComponent(a.id)}">${escapeHtml(a.title || a.id)}</a></td>
        <td>${pill(a.inboxStatus || 'pending', INBOX_BADGE[a.inboxStatus] || 'badge-disabled')}</td>
        <td class="num text-dim">${formatNumber(a.questionChars)}</td>
        <td class="text-dim">${relativeTime(a.createdAt)}</td>
        <td class="text-dim">${a.answeredAt ? relativeTime(a.answeredAt) : '--'}</td>
      </tr>`
      )
      .join('')}</tbody></table>`;
}

function errorsList(errors) {
  const list = Array.isArray(errors) ? errors : [];
  if (list.length === 0) return '<p class="text-dim text-sm">No errors in window.</p>';
  return list
    .map(
      (e) =>
        `<div class="stats-error-row"><span class="stats-flag">${formatNumber(e.count)}×</span> <span class="mono text-sm">${escapeHtml(e.message)}</span></div>`
    )
    .join('');
}

function soulPanel(soul) {
  const s = soul || {};
  const missing = Array.isArray(s.missingFiles) ? s.missingFiles : [];
  return `<div class="stats-kv">
    <div><span class="text-dim">MEMORY.md</span><span class="num">${formatBytes(s.memoryBytes)}</span></div>
    <div><span class="text-dim">GOALS.md</span><span class="num">${formatBytes(s.goalsBytes)}</span></div>
    <div><span class="text-dim">Last reflection</span><span>${relativeTime(s.lastReflectionAt)}</span></div>
    <div><span class="text-dim">Last health check</span><span>${relativeTime(s.lastHealthCheckAt)}</span></div>
    <div><span class="text-dim">Daily logs pending</span><span class="num ${s.dailyLogsPending > 0 ? 'stats-warn' : ''}">${formatNumber(s.dailyLogsPending)}</span></div>
  </div>
  ${s.soulEqualsMotivations ? '<div class="soul-banner soul-banner-warn"><span class="soul-banner-icon">!</span><span class="soul-banner-text">SOUL.md is identical to MOTIVATIONS.md — the identity file never diverged.</span></div>' : ''}
  ${
    missing.length
      ? `<div class="soul-banner soul-banner-error"><span class="soul-banner-icon">!</span><span class="soul-banner-text">Missing soul files: ${missing.map((m) => `<span class="mono">${escapeHtml(m)}</span>`).join(', ')}</span></div>`
      : ''
  }`;
}

function botKpis(b) {
  const llmFail = b.llm?.failRate ?? answerRate(b.llm?.failed, b.llm?.calls);
  const toolFail = b.tools?.failRate ?? answerRate(b.tools?.failed, b.tools?.calls);
  return [
    kpi('LLM calls', formatNumber(b.llm?.calls), {
      sub: `${formatPct(llmFail)} failed · ${formatDuration(b.llm?.avgDurationMs)} avg`,
      state: failRateClass(llmFail) === 'ok' ? null : failRateClass(llmFail),
    }),
    kpi('Tool calls', formatNumber(b.tools?.calls), {
      sub: `${formatPct(toolFail)} failed${b.tools?.loopBreaks ? ` · ${formatNumber(b.tools.loopBreaks)} loop breaks` : ''}`,
      state: failRateClass(toolFail) === 'ok' ? null : failRateClass(toolFail),
    }),
    kpi('Files', `${formatNumber(b.output?.filesActive)}`, {
      sub: `${formatNumber(b.output?.unreviewed)} unreviewed · ${formatNumber(b.output?.approved)} ok · ${formatNumber(b.output?.rejected)} rej`,
      state: b.output?.unreviewed > 0 ? 'warn' : null,
    }),
    kpi('Asks pending', formatNumber(b.engagement?.asksPending), {
      sub: `${formatNumber(b.engagement?.asksSent)} sent · ${formatNumber(b.engagement?.asksAnswered)} answered`,
      state: b.engagement?.asksPending > 0 ? 'warn' : null,
    }),
    kpi('Cycles', formatNumber(b.cycles?.total), {
      sub: `${formatNumber(b.cycles?.idle)} idle · ${formatDuration(b.cycles?.avgDurationMs)} avg${
        b.cycles?.alignmentWarnings
          ? ` · ${formatNumber(b.cycles.alignmentWarnings)} align warn`
          : ''
      }`,
    }),
    kpi('Prompt tokens', formatTokens(b.llm?.promptTokens), {
      sub: `${formatTokens(b.llm?.completionTokens)} completion`,
    }),
    kpi('Karma', b.karma?.score != null ? formatNumber(b.karma.score) : '--', {
      sub: `${delta(b.karma?.delta) || '±0'} · ${formatNumber(b.karma?.events)} events`,
    }),
  ].join('');
}

/**
 * Key → record table. `cols` = [{ label, key, tokens?, fail? }] for the value columns.
 */
function kvTable(obj, firstLabel, cols) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) return '<p class="text-dim text-sm">None.</p>';
  return `<table class="stats-table"><thead><tr><th>${firstLabel}</th>${cols
    .map((c) => `<th class="num">${c.label}</th>`)
    .join('')}</tr></thead><tbody>${entries
    .map(
      ([k, v]) =>
        `<tr><td class="mono">${escapeHtml(k)}</td>${cols
          .map((c) => {
            const val = v?.[c.key];
            return `<td class="num ${c.fail && val ? 'stats-bad' : ''}">${c.tokens ? formatTokens(val) : formatNumber(val)}</td>`;
          })
          .join('')}</tr>`
    )
    .join('')}</tbody></table>`;
}

export async function renderStatsBot(el, botId) {
  const body = shell(el, 'fleet', {
    withWindow: true,
    onWindowChange: () => renderStatsBot(el, botId),
    subtitle: escapeHtml(botId),
  });
  const w = getWindow();
  const [b, routinesRes] = await Promise.all([
    api(`/api/stats/bots/${encodeURIComponent(botId)}${windowQuery(w)}`),
    loadRoutines(),
  ]);
  if (!b || b.error || !b.botId) return errorState(body, b, `Stats for ${escapeHtml(botId)}`);

  const botRoutines = routinesRes.routines.filter((r) => r.scope !== 'fleet');
  const topTools = Array.isArray(b.tools?.top) ? b.tools.top : [];

  body.innerHTML = `
    <div class="flex-between mb-16 stats-bot-head">
      <div>
        <div class="stats-bot-name">${escapeHtml(b.name || b.botId)} ${posturePill(b.posture)} ${channelPill(b.channel)}${
          b.enabled === false ? ' <span class="badge badge-disabled">disabled</span>' : ''
        }</div>
        <div class="text-dim text-sm">${escapeHtml(b.botId)} · ${escapeHtml(b.backend || '--')} · ${escapeHtml(b.model || '--')} · ${escapeHtml(
          b.loop?.cadence || b.loop?.mode || 'no loop'
        )} · next ${relativeTime(b.loop?.nextRunAt)} · last ${relativeTime(b.loop?.lastRunAt)}${
          b.loop?.retryCount
            ? ` · <span class="stats-warn">${formatNumber(b.loop.retryCount)} retries</span>`
            : ''
        } · last human <span class="${isStaleContact(b.lastHumanContactAt) ? 'stats-stale' : ''}">${relativeTime(b.lastHumanContactAt)}</span></div>
        ${b.loop?.lastError ? `<div class="stats-bad text-sm mono">${escapeHtml(b.loop.lastError)}</div>` : ''}
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <a href="#/agents/${encodeURIComponent(b.botId)}" class="btn btn-sm">Agent</a>
        <a href="#/stats" class="btn btn-sm">&larr; Fleet</a>
      </div>
    </div>
    <div class="stats-kpis">${botKpis(b)}</div>

    <div class="stats-grid-2">
      ${section('LLM calls per day', dailyChart(b.llmDaily, { label: 'calls' }), ' <span class="count">red = failed</span>')}
      ${section('Tool calls per day', dailyChart(b.toolsDaily, { label: 'tool calls' }), ' <span class="count">red = failed</span>')}
    </div>

    <div class="detail-card">
      <div class="flex-between" style="flex-wrap:wrap;gap:8px">
        <div class="stats-section-title" style="margin-bottom:0">Hygiene</div>
        <div class="hyg-actions" id="stats-bot-hyg-actions">${botRoutines
          .map(
            (r) =>
              `<button class="btn btn-sm stats-hyg-btn" data-routine="${escapeHtml(r.id)}" title="${escapeHtml(r.description || '')}">Run ${escapeHtml(r.name || r.id)} (preview)</button>`
          )
          .join('')}</div>
      </div>
      <div id="stats-bot-hyg-result"></div>
      <details class="stats-details"><summary class="text-dim text-sm">History for this bot</summary><div id="stats-bot-hyg-history"></div></details>
    </div>

    <div class="stats-grid-2">
      ${section('Trait drift', traitsPanel(b.traits), b.traits?.drift != null && typeof b.traits.drift === 'number' ? ` <span class="count">drift ${b.traits.drift}</span>` : '')}
      ${section('Soul', soulPanel(b.soul))}
    </div>

    ${section(
      'Goals',
      goalsBoard(b.goalsDetail, b.goals),
      ` <span class="count">${formatNumber(b.goals?.active)} active · ${formatNumber(b.goals?.completed)} completed${
        b.goals?.lastCompletedAt ? ` · last ${relativeTime(b.goals.lastCompletedAt)}` : ''
      }</span>`
    )}

    <div class="stats-grid-2">
      ${section('Recent cycles', cyclesList(b.recentCycles), b.lastLoggedSummary ? ` <span class="count" title="${escapeHtml(String(b.lastLoggedSummary))}">last summary</span>` : '')}
      ${section('Asks', asksList(b.asks, b.botId), ` <span class="count">${formatNumber(b.engagement?.asksClosedUnanswered)} closed unanswered</span>`)}
    </div>

    <div class="stats-grid-2">
      ${section(
        'Top tools',
        topTools.length
          ? `<table class="stats-table"><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Failed</th></tr></thead><tbody>${topTools
              .map(
                (t) =>
                  `<tr><td class="mono">${escapeHtml(t.name)}</td><td class="num">${formatNumber(t.count)}</td><td class="num ${t.failed ? 'stats-bad' : 'text-dim'}">${formatNumber(t.failed)}</td></tr>`
              )
              .join('')}</tbody></table>`
          : '<p class="text-dim text-sm">No tool calls in window.</p>'
      )}
      ${section('Top errors', errorsList(b.topErrors), b.llm?.lastError ? ` <span class="count" title="${escapeHtml(b.llm.lastError)}">last LLM error ${relativeTime(b.llm.lastCallAt)}</span>` : '')}
    </div>

    <div class="stats-grid-2">
      ${section(
        'LLM by caller',
        kvTable(b.llm?.byCaller, 'Caller', [
          { label: 'Calls', key: 'calls' },
          { label: 'Failed', key: 'failed', fail: true },
        ])
      )}
      ${section(
        'LLM by model',
        kvTable(b.llm?.byModel, 'Model', [
          { label: 'Calls', key: 'calls' },
          { label: 'Prompt tokens', key: 'promptTokens', tokens: true },
          { label: 'Completion tokens', key: 'completionTokens', tokens: true },
        ])
      )}
    </div>

    ${
      b.lastLoggedSummary
        ? section(
            'Last logged summary',
            `<pre class="stats-pre">${escapeHtml(String(b.lastLoggedSummary))}</pre>`
          )
        : ''
    }
    ${
      b.engagement
        ? section(
            'Engagement',
            `<div class="stats-kv">
              <div><span class="text-dim">Proactive messages</span><span class="num">${formatNumber(b.engagement.messagesSentProactive)}</span></div>
              <div><span class="text-dim">Collaborate calls</span><span class="num">${formatNumber(b.engagement.collaborateCalls)}${
                b.engagement.collaborateFailed
                  ? ` <span class="stats-bad">${formatNumber(b.engagement.collaborateFailed)} failed</span>`
                  : ''
              }</span></div>
              <div><span class="text-dim">Mesh published</span><span class="num">${formatNumber(b.engagement.meshPublished)}</span></div>
              <div><span class="text-dim">Outcomes</span><span class="num">${formatNumber(b.output?.outcomesProduced)}${
                b.output?.outcomesStale
                  ? ` <span class="stats-warn">${formatNumber(b.output.outcomesStale)} stale</span>`
                  : ''
              }</span></div>
              <div><span class="text-dim">Last file</span><span>${relativeTime(b.output?.lastFileAt)}</span></div>
            </div>`
          )
        : ''
    }`;

  const hygTarget = body.querySelector('#stats-bot-hyg-result');
  body.querySelectorAll('.stats-hyg-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await runAndRender(hygTarget, {
        routine: btn.dataset.routine,
        botId: b.botId,
        title: btn.dataset.routine,
      });
      btn.disabled = false;
      loadBotHistory();
    });
  });

  async function loadBotHistory() {
    const res = await api(`/api/hygiene/history?botId=${encodeURIComponent(b.botId)}&limit=20`);
    renderHistoryTable(
      body.querySelector('#stats-bot-hyg-history'),
      Array.isArray(res) ? res : [],
      {
        onSelect: (run) => renderHygieneRun(hygTarget, run),
      }
    );
  }
  loadBotHistory();
}

/* ========================= Behaviour ========================= */

function pwfBars(list) {
  const rows = Array.isArray(list) ? [...list] : [];
  if (rows.length === 0) return '<p class="text-dim text-sm">No data.</p>';
  rows.sort((a, b) => (b.outputsSinceFeedback || 0) - (a.outputsSinceFeedback || 0));
  const heights = barHeights(rows.map((r) => r.outputsSinceFeedback || 0));
  return `<div class="stats-hbars">${rows
    .map(
      (r, i) => `<div class="stats-hbar-row" title="${escapeHtml(
        `${r.botId}: ${formatNumber(r.outputsSinceFeedback)} outputs since feedback (${relativeTime(r.lastFeedbackAt)})`
      )}">
      <a class="stats-hbar-label" href="#/stats/bot/${encodeURIComponent(r.botId)}">${escapeHtml(r.botId)}</a>
      <span class="stats-hbar-track"><span class="stats-hbar-fill${r.outputsSinceFeedback >= 10 ? ' warn' : ''}" style="width:${heights[i]}%"></span></span>
      <span class="num stats-hbar-val">${formatNumber(r.outputsSinceFeedback)}</span>
      <span class="text-dim text-sm">${relativeTime(r.lastFeedbackAt)}</span>
    </div>`
    )
    .join('')}</div>`;
}

function askEconomicsTable(eco) {
  const buckets = Array.isArray(eco?.buckets) ? eco.buckets : [];
  if (buckets.length === 0) return '<p class="text-dim text-sm">No asks in window.</p>';
  return `<table class="stats-table"><thead><tr><th>Bucket</th><th class="num">Sent</th><th class="num">Answered</th><th class="num">Rate</th><th class="num">Median time</th></tr></thead>
  <tbody>${buckets
    .map((bk) => {
      const rate = answerRate(bk.answered, bk.sent);
      return `<tr><td>${escapeHtml(String(bk.bucket))}</td><td class="num">${formatNumber(bk.sent)}</td><td class="num">${formatNumber(bk.answered)}</td><td class="num">${formatPct(rate)}${inlineBar(
        rate != null ? 1 - rate : 0,
        `${formatPct(rate)} answered`
      )}</td><td class="num text-dim">${formatDuration(bk.medianTimeToAnswerMs)}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function collabMatrix(collab) {
  const nodes = Array.isArray(collab?.nodes) ? collab.nodes.map((n) => n.botId) : [];
  const edges = Array.isArray(collab?.edges) ? collab.edges : [];
  if (nodes.length === 0 || edges.length === 0)
    return '<p class="text-dim text-sm">No collaboration calls in window.</p>';
  const cell = (from, to) => {
    if (from === to) return '<td class="stats-matrix-self"></td>';
    const e = edges.find((x) => x.from === from && x.to === to);
    if (!e || !e.calls) return '<td class="num text-dim">·</td>';
    return `<td class="num" title="${escapeHtml(`${from} → ${to}: ${e.calls} calls, ${e.failed || 0} failed`)}">${formatNumber(e.calls)}${
      e.failed ? ` <span class="stats-bad">${formatNumber(e.failed)}</span>` : ''
    }</td>`;
  };
  return `<div class="stats-table-wrap"><table class="stats-table stats-matrix"><thead><tr><th>from \\ to</th>${nodes
    .map((n) => `<th class="num">${escapeHtml(n)}</th>`)
    .join('')}</tr></thead>
  <tbody>${nodes.map((f) => `<tr><td class="mono">${escapeHtml(f)}</td>${nodes.map((t) => cell(f, t)).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function meshTable(mesh) {
  const entries = Object.entries(mesh?.byBot || {});
  if (entries.length === 0) return '<p class="text-dim text-sm">No mesh activity.</p>';
  const val = (v) =>
    typeof v === 'number' ? formatNumber(v) : formatNumber(v?.published ?? v?.count ?? v?.total);
  return `<table class="stats-table"><thead><tr><th>Bot</th><th class="num">Published</th></tr></thead><tbody>${entries
    .map(
      ([k, v]) => `<tr><td class="mono">${escapeHtml(k)}</td><td class="num">${val(v)}</td></tr>`
    )
    .join('')}</tbody></table>`;
}

function driftVector(vec) {
  const rows = driftVectorData(vec);
  if (rows.length === 0) return '<p class="text-dim text-sm">No drift data.</p>';
  return `<div class="stats-drift">${rows
    .map(
      (
        r
      ) => `<div class="stats-drift-row" title="${escapeHtml(`${r.trait}: ${r.value > 0 ? '+' : ''}${r.value}`)}">
      <span class="stats-drift-name">${escapeHtml(r.trait)}</span>
      <span class="stats-drift-track"><span class="stats-drift-bar ${r.sign}" style="width:${r.pct / 2}%"></span></span>
      <span class="num stats-drift-val">${delta(r.value) || '0'}</span>
    </div>`
    )
    .join('')}</div>`;
}

function varianceSparks(points) {
  const list = Array.isArray(points) ? points.slice(-30) : [];
  if (list.length < 2) return '<p class="text-dim text-sm">Not enough variance samples yet.</p>';
  const traits = [...new Set(list.flatMap((p) => Object.keys(p.variance || {})))];
  if (traits.length === 0) return '<p class="text-dim text-sm">No variance data.</p>';
  const W = 160;
  const H = 28;
  return `<div class="stats-sparks">${traits
    .map((t) => {
      const series = list.map((p) => p.variance?.[t] ?? 0);
      const last = series[series.length - 1];
      return `<div class="stats-spark" title="${escapeHtml(`${t}: ${series.map((v) => Math.round(v * 1000) / 1000).join(' → ')}`)}">
        <span class="stats-spark-name">${escapeHtml(t)}</span>
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none"><polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="${sparklinePoints(series, W, H)}"/></svg>
        <span class="num stats-spark-val">${Math.round(last * 1000) / 1000}</span>
      </div>`;
    })
    .join('')}
    <div class="text-dim text-sm">last ${list.length} samples · ${relativeTime(list[0].timestamp)} → ${relativeTime(list[list.length - 1].timestamp)}</div></div>`;
}

export async function renderStatsBehaviour(el) {
  const body = shell(el, 'behaviour', {
    withWindow: true,
    onWindowChange: () => renderStatsBehaviour(el),
  });
  const data = await api(`/api/stats/behaviour${windowQuery(getWindow())}`);
  if (!data || data.error) return errorState(body, data, 'Behaviour stats');

  body.innerHTML = `
    <div class="stats-grid-2">
      ${section('Production without feedback', pwfBars(data.productionWithoutFeedback), ' <span class="count">outputs since last human feedback</span>')}
      ${section('Ask economics', askEconomicsTable(data.askEconomics))}
    </div>
    <div class="stats-grid-2">
      ${section('Collaboration matrix', collabMatrix(data.collaboration), ' <span class="count">calls · <span class="stats-bad">failed</span></span>')}
      ${section('Mesh', meshTable(data.mesh), ` <span class="count">${formatNumber(data.mesh?.total)} total</span>`)}
    </div>
    <div class="stats-grid-2">
      ${section('Fleet drift vector', driftVector(data.fleetDriftVector), ' <span class="count">signed mean drift per trait</span>')}
      ${section('Trait variance', varianceSparks(data.traitVariance), ' <span class="count">spread across bots over time</span>')}
    </div>`;
}

/* ========================= Infra ========================= */

function cronStatusPill(status) {
  const s = String(status || 'never');
  const cls = /^(ok|success|completed)$/i.test(s)
    ? 'badge-ok'
    : /^(error|failed|fail)$/i.test(s)
      ? 'badge-error'
      : /^(running)$/i.test(s)
        ? 'badge-mcp'
        : 'badge-disabled';
  return pill(s, cls);
}

export async function renderStatsInfra(el) {
  const body = shell(el, 'infra');
  const data = await api('/api/stats/infra');
  if (!data || data.error) return errorState(body, data, 'Infra stats');

  const backends = Array.isArray(data.backends) ? data.backends : [];
  const telegram = Array.isArray(data.telegram) ? data.telegram : [];
  const audit = Array.isArray(data.securityAudit) ? data.securityAudit : [];
  const cron = Array.isArray(data.cron) ? data.cron : [];
  const noise = (Array.isArray(data.logNoise) ? [...data.logNoise] : [])
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 15);
  const boots = (Array.isArray(data.boots) ? [...data.boots] : []).sort(
    (a, b) => Date.parse(b) - Date.parse(a)
  );

  // Circuit breaker: open = the agent loop is skipping cycles on this backend.
  const circuitPill = (c) => {
    if (!c) return '<span class="text-dim">--</span>';
    if (c.open) {
      return `${pill('open', 'badge-error')} <span class="text-sm text-dim" title="${escapeHtml(c.lastError || '')}">until ${relativeTime(c.until)} · ${formatNumber(c.consecutiveFailures)} fails</span>`;
    }
    if (c.halfOpen) return pill('half-open', 'stats-badge-amber');
    return pill('closed', 'badge-ok');
  };
  const backendsHtml = backends.length
    ? `<table class="stats-table"><thead><tr><th>Backend</th><th>Circuit</th><th>Last 429</th><th>Last 401</th><th class="num">Failed 24h</th><th>Last error</th></tr></thead><tbody>${backends
        .map(
          (b) => `<tr>
          <td class="mono">${escapeHtml(b.name)}</td>
          <td>${circuitPill(b.circuit)}</td>
          <td class="${b.last429At ? 'stats-warn' : 'text-dim'}">${relativeTime(b.last429At)}</td>
          <td class="${b.last401At ? 'stats-bad' : 'text-dim'}">${relativeTime(b.last401At)}</td>
          <td class="num ${b.failedCalls24h ? 'stats-bad' : 'text-dim'}">${formatNumber(b.failedCalls24h)}</td>
          <td class="text-sm mono stats-ellipsis" title="${escapeHtml(b.lastErrorMessage || '')}">${escapeHtml(b.lastErrorMessage || '--')}</td>
        </tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="text-dim text-sm">No backend activity recorded.</p>';

  const telegramHtml = telegram.length
    ? `<table class="stats-table"><thead><tr><th>Bot</th><th>State</th><th>Last error</th></tr></thead><tbody>${telegram
        .map(
          (t) =>
            `<tr><td><a href="#/stats/bot/${encodeURIComponent(t.botId)}">${escapeHtml(t.botId)}</a></td><td>${pill(t.state || 'unknown', channelStateClass(t.state))}</td><td class="text-sm mono stats-ellipsis" title="${escapeHtml(t.lastError || '')}">${escapeHtml(t.lastError || '--')}</td></tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="text-dim text-sm">No Telegram bots.</p>';

  const auditHtml = audit.length
    ? `<table class="stats-table"><thead><tr><th>Bot</th><th class="num">Critical</th><th class="num">Warn</th><th class="num">Info</th><th>When</th></tr></thead><tbody>${audit
        .map(
          (a) =>
            `<tr><td>${a.botId ? `<a href="#/stats/bot/${encodeURIComponent(a.botId)}">${escapeHtml(a.botId)}</a>` : '<span class="text-dim">system</span>'}</td><td class="num ${a.critical ? 'stats-bad' : 'text-dim'}">${formatNumber(a.critical)}</td><td class="num ${a.warn ? 'stats-warn' : 'text-dim'}">${formatNumber(a.warn)}</td><td class="num text-dim">${formatNumber(a.info)}</td><td class="text-dim">${relativeTime(a.at)}</td></tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="text-dim text-sm">No security audit results.</p>';

  const cronHtml = cron.length
    ? `<table class="stats-table"><thead><tr><th>Job</th><th>Bot</th><th>Schedule</th><th>Status</th><th>Last run</th><th>Next run</th><th class="num">Consec. errors</th><th>Error</th></tr></thead><tbody>${cron
        .map(
          (c) => `<tr class="${c.enabled === false ? 'stats-row-dim' : ''}">
          <td><a href="#/cron/${encodeURIComponent(c.id)}">${escapeHtml(c.name || c.id)}</a>${c.enabled === false ? ' <span class="badge badge-disabled">off</span>' : ''}</td>
          <td class="text-sm">${escapeHtml(c.botId || '--')}</td>
          <td class="mono text-sm">${escapeHtml(c.schedule || '--')}</td>
          <td>${cronStatusPill(c.lastStatus)}</td>
          <td class="text-dim">${relativeTime(c.lastRunAt)}</td>
          <td class="text-dim">${relativeTime(c.nextRunAt)}</td>
          <td class="num ${c.consecutiveErrors ? 'stats-bad' : 'text-dim'}">${formatNumber(c.consecutiveErrors)}</td>
          <td class="text-sm mono stats-ellipsis" title="${escapeHtml(c.lastError || '')}">${escapeHtml(c.lastError || '')}</td>
        </tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="text-dim text-sm">No cron jobs.</p>';

  const noiseHtml = noise.length
    ? noise
        .map(
          (n) =>
            `<div class="stats-error-row"><span class="stats-flag">${formatNumber(n.count)}×</span> <span class="log-badge log-badge-${escapeHtml(String(n.level || 'info').toLowerCase())}">${escapeHtml(String(n.level || ''))}</span> <span class="mono text-sm">${escapeHtml(n.msg)}</span></div>`
        )
        .join('')
    : '<p class="text-dim text-sm">No log noise.</p>';

  const bootsHtml = boots.length
    ? `<div class="stats-boots">${boots
        .slice(0, 20)
        .map(
          (b) =>
            `<div><span>${relativeTime(b)}</span><span class="text-dim mono text-sm">${escapeHtml(b)}</span></div>`
        )
        .join('')}</div>`
    : '<p class="text-dim text-sm">No boots recorded.</p>';

  body.innerHTML = `
    <div class="stats-kpis">
      ${kpi('Backends', formatNumber(backends.length), {
        sub: `${formatNumber(backends.reduce((s, b) => s + (b.failedCalls24h || 0), 0))} failed calls 24h`,
        state: backends.some((b) => b.last401At)
          ? 'bad'
          : backends.some((b) => b.last429At)
            ? 'warn'
            : null,
      })}
      ${kpi('Telegram', `${telegram.filter((t) => t.state === 'ok').length}/${telegram.length}`, {
        sub: 'ok / total',
        state: telegram.some((t) => t.state === 'revoked' || t.state === 'missing') ? 'bad' : null,
      })}
      ${kpi('Cron errors', formatNumber(cron.filter((c) => c.consecutiveErrors > 0).length), {
        sub: `${formatNumber(cron.length)} jobs`,
        state: cron.some((c) => c.consecutiveErrors > 0) ? 'warn' : null,
      })}
      ${kpi('Boots', formatNumber(boots.length), { sub: boots[0] ? `last ${relativeTime(boots[0])}` : '' })}
      ${kpi('Log size', formatBytes(data.logBytes))}
    </div>
    <div class="stats-grid-2">
      ${section('LLM backends', backendsHtml)}
      ${section('Telegram', telegramHtml)}
    </div>
    ${section('Cron', cronHtml)}
    <div class="stats-grid-2">
      ${section('Security audit', auditHtml)}
      ${section('Boots', bootsHtml)}
    </div>
    ${section('Log noise', noiseHtml, ' <span class="count">top 15 repeated messages</span>')}`;
}

/* ========================= Hygiene ========================= */

export async function renderStatsHygiene(el) {
  const body = shell(el, 'hygiene');
  await renderHygienePanel(body);
}

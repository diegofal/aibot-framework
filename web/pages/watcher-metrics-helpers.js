/**
 * Watcher page, phase 3 (pure half): the metrics strip, the insight rows and
 * the broadcast rows. Data in, HTML string out: no DOM, no Three.js, so
 * `tests/web/watcher-metrics-helpers.test.ts` runs it under Bun. A Why is
 * only ever rendered through the shared `whyPanel`; "Open cycle" is the
 * shared `[data-open-cycle]` + `data-bot-id` contract (cycle-sheet.js).
 */
import { esc } from '../ui/index.js';
import { whyPanel } from './why-helpers.js';

/** Kinds the operator can 👍/👎 on the page (contradictions: confirm or dismiss). */
export const SIGNAL_NEURON_KINDS = ['insight', 'contradiction', 'prediction'];
const MAX_ROWS = 30;

/** One metric or guard value in words, by unit; never "NaN". */
export function formatMetricValue(value, unit) {
  const v = Number(value);
  if (value === undefined || value === null || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'share':
    case 'score':
      return `${Math.round(v * 100)} %`;
    case 'ms':
      if (v < 60_000) return `${(v / 1000).toFixed(1)} s`;
      if (v < 3_600_000) return `${(v / 60_000).toFixed(1)} min`;
      return `${(v / 3_600_000).toFixed(1)} h`;
    case 'brier':
      return v.toFixed(2);
    case 'perWeek':
      return `${v.toFixed(1)} / wk`;
    case 'usd':
      return `$${v.toFixed(2)}`;
    default:
      return String(Math.round(v * 100) / 100);
  }
}

function relTime(iso, nowMs) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const d = nowMs - t;
  const abs = Math.abs(d);
  const unit =
    abs < 60_000
      ? 'just now'
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} min`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)} h`
          : `${Math.round(abs / 86_400_000)} d`;
  if (unit === 'just now') return unit;
  return d >= 0 ? `${unit} ago` : `in ${unit}`;
}

/** The metric table above the ball: value, baseline, target; guards red when over. */
export function metricsStripHtml(data) {
  const metrics = Array.isArray(data?.metrics) ? data.metrics : [];
  const guards = Array.isArray(data?.guards) ? data.guards : [];
  const cells = metrics.map((m) => {
    const value = m.n > 0 ? formatMetricValue(m.value, m.unit) : 'no data yet';
    return `<div class="watcher-metric" data-metric="${esc(m.id)}" title="${esc(
      `${m.n} record${m.n === 1 ? '' : 's'}`
    )}"><div class="watcher-metric-label">${esc(m.label)}</div><div class="watcher-metric-value">${esc(
      value
    )}</div><div class="watcher-metric-sub text-dim">baseline ${esc(
      formatMetricValue(m.baseline, m.unit)
    )} · target ${esc(m.target)}</div></div>`;
  });
  const guardCells = guards.map(
    (g) =>
      `<div class="watcher-guard${g.over ? ' watcher-guard-over' : ''}" data-guard="${esc(
        g.id
      )}"><span class="watcher-guard-label">${esc(g.label)}</span> <span class="watcher-guard-value">${esc(
        formatMetricValue(g.value, g.unit)
      )}</span> <span class="text-dim">limit ${esc(formatMetricValue(g.limit, g.unit))}</span></div>`
  );
  const span = data?.window ? `<span class="text-dim">last ${esc(data.window)}</span>` : '';
  return `<section class="watcher-metrics" aria-label="Watcher metrics"><div class="watcher-metrics-head">Metrics ${span}</div><div class="watcher-metrics-grid">${cells.join(
    ''
  )}</div><div class="watcher-guards">${guardCells.join('')}</div></section>`;
}

/** 👍/👎 for an insight (`n-…`) or a broadcast (`b-…`); the current one pressed. */
export function signalButtonsHtml(id, current) {
  const btn = (signal, label) =>
    `<button type="button" class="btn btn-sm watcher-signal" data-watcher-signal="${signal}" data-signal-id="${esc(
      id
    )}" aria-pressed="${current === signal ? 'true' : 'false'}" aria-label="${signal === 'up' ? 'Useful' : 'Not useful'}">${label}</button>`;
  return `<span class="watcher-signals">${btn('up', '👍')}${btn('down', '👎')}</span>`;
}

function predictionLine(n, nowMs) {
  const p = Number(n.meta?.probability);
  const parts = [];
  if (Number.isFinite(p)) parts.push(`${Math.round(p * 100)} %`);
  if (n.meta?.resolvedAt) {
    parts.push(n.meta.happened === 'true' ? 'came true' : 'did not happen');
    const brier = Number(n.meta.brier);
    if (Number.isFinite(brier)) parts.push(`Brier ${brier.toFixed(2)}`);
  } else if (n.meta?.dueAt) {
    parts.push(`due ${relTime(n.meta.dueAt, nowMs)}`);
  }
  return parts.join(' · ');
}

/** The watcher's own thoughts (insights, contradictions, predictions), newest first. */
export function insightRowsHtml(neurons, nowMs = Date.now()) {
  const rows = (Array.isArray(neurons) ? neurons : [])
    .filter((n) => SIGNAL_NEURON_KINDS.includes(n?.kind) && !n.archivedAt)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, MAX_ROWS);
  if (rows.length === 0) {
    return '<div class="watcher-insights-empty text-dim">No insights yet. They appear after the first integration pass.</div>';
  }
  const items = rows.map((n) => {
    const bots = Array.isArray(n.support?.bots) ? n.support.bots.join(', ') : '';
    const extra = n.kind === 'prediction' ? predictionLine(n, nowMs) : '';
    return `<li class="watcher-insight" data-kind="${esc(n.kind)}"><button type="button" class="watcher-insight-text" data-watcher-neuron="${esc(
      n.id
    )}"><span class="watcher-insight-kind">${esc(n.kind)}</span> ${esc(n.text)}</button><div class="watcher-insight-meta text-dim">${esc(
      [relTime(n.createdAt, nowMs), bots, extra].filter(Boolean).join(' · ')
    )}</div>${signalButtonsHtml(n.id, n.meta?.signal)}</li>`;
  });
  return `<ul class="watcher-insights">${items.join('')}</ul>`;
}

const KIND_VERB = { wake: 'woke', directive: 'directive', goal: 'goal', question: 'asked you' };

/** Broadcasts newest first: kind, bot, text, served by which cycle (Open cycle), Why, signals. */
export function broadcastRowsHtml(broadcasts, nowMs = Date.now()) {
  const rows = (Array.isArray(broadcasts) ? broadcasts : []).slice(0, MAX_ROWS);
  if (rows.length === 0) {
    return '<div class="watcher-broadcasts-empty text-dim">No broadcasts yet.</div>';
  }
  const items = rows.map((b) => {
    let state;
    if (!b.deliveredAt && b.deferred)
      state = `<span class="text-dim">held by the throttle: ${esc(b.deliveryError ?? '')}</span>`;
    else if (!b.deliveredAt)
      state = `<span class="watcher-bc-failed">not delivered: ${esc(b.deliveryError ?? '')}</span>`;
    else if (b.servedByCycle) {
      state = `served by cycle <button type="button" class="btn btn-sm" data-open-cycle="${esc(
        b.servedByCycle
      )}" data-bot-id="${esc(b.botId)}">Open cycle</button>`;
    } else state = '<span class="text-dim">not served yet</span>';
    const text = b.text ? ` ${esc(b.text)}` : '';
    return `<li class="watcher-broadcast" data-kind="${esc(b.kind)}"><div class="watcher-bc-head"><span class="watcher-bc-kind">${esc(
      KIND_VERB[b.kind] ?? b.kind
    )}</span> <span class="watcher-bc-bot">${esc(b.botId)}</span>${text}</div><div class="watcher-bc-meta">${esc(
      relTime(b.createdAt, nowMs)
    )} · ${state}</div>${b.why ? whyPanel(b.why, { nowMs, botId: b.botId }) : ''}${signalButtonsHtml(
      b.id,
      b.signal
    )}</li>`;
  });
  return `<ul class="watcher-broadcasts">${items.join('')}</ul>`;
}

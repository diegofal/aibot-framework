/**
 * Watcher page, phase 3 (pure half): the metrics strip and the 👍/👎
 * buttons (the insight and broadcast lists live in the Mind panel,
 * `watcher-mind-helpers.js`). Data in, HTML string out: no DOM, no Three.js, so
 * `tests/web/watcher-metrics-helpers.test.ts` runs it under Bun.
 */
import { esc } from '../ui/index.js';

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
  return `<section class="watcher-metrics" aria-label="Watcher metrics"><div class="watcher-metrics-head">Metrics ${span}</div><div class="watcher-card-sub">The properties the watcher plan measures; each tile: now, baseline before the watcher, target. Guards below turn red when over their limit.</div><div class="watcher-metrics-grid">${cells.join(
    ''
  )}</div><div class="watcher-guards">${guardCells.join('')}</div></section>`;
}

/**
 * 👍/👎 for an insight (`n-…`) or a broadcast (`b-…`); the current one
 * pressed. `labels` replaces the thumbs with words (a contradiction's
 * Confirm / Dismiss: the same up / down signal).
 */
export function signalButtonsHtml(id, current, labels = null) {
  const btn = (signal, thumb) => {
    const word = labels?.[signal];
    const aria = word ?? (signal === 'up' ? 'Useful' : 'Not useful');
    return `<button type="button" class="btn btn-sm watcher-signal" data-watcher-signal="${signal}" data-signal-id="${esc(
      id
    )}" aria-pressed="${current === signal ? 'true' : 'false'}" aria-label="${esc(aria)}">${esc(word ?? thumb)}</button>`;
  };
  return `<span class="watcher-signals">${btn('up', '👍')}${btn('down', '👎')}</span>`;
}

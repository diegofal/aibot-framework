import { cx, esc } from './escape.js';

/** Format a delta as a signed label; `null`/`0` yields no delta chip. */
export function deltaLabel(delta) {
  if (delta == null || Number.isNaN(Number(delta)) || Number(delta) === 0) return null;
  const n = Number(delta);
  const text = Number.isInteger(n) ? String(Math.abs(n)) : Math.abs(n).toFixed(1);
  return { text: `${n > 0 ? '+' : '−'}${text}`, tone: n > 0 ? 'ok' : 'danger' };
}

/**
 * Big-number tile. `label`, `value` and `hint` are escaped. `delta` is a
 * number rendered as a signed chip. `tone` colours the value.
 */
export function kpi({ label, value, delta, tone, hint, class: cls } = {}) {
  const d = deltaLabel(delta);
  return `<div class="${cx('ui-kpi', tone ? `ui-kpi-${tone}` : '', cls)}"><div class="ui-kpi-label">${esc(
    label
  )}</div><div class="ui-kpi-row"><div class="ui-kpi-value">${esc(
    value ?? '--'
  )}</div>${d ? `<span class="ui-kpi-delta ui-kpi-delta-${d.tone}">${d.text}</span>` : ''}</div>${
    hint ? `<div class="ui-kpi-hint">${esc(hint)}</div>` : ''
  }</div>`;
}

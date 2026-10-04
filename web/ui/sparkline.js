import { cx } from './escape.js';

/** Keep finite numbers (and numeric strings) only; null, '' and booleans are dropped. */
function clean(values) {
  return (Array.isArray(values) ? values : [])
    .filter((v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== ''))
    .map(Number)
    .filter((v) => Number.isFinite(v));
}

/**
 * Points for a polyline, "x,y x,y …", scaled into `width`×`height` with a
 * 1px vertical inset so the stroke never clips. A single value draws a flat
 * line across the full width. Returns '' when there is nothing to draw.
 */
export function sparklinePath(values, width = 120, height = 32) {
  const v = clean(values);
  if (v.length === 0) return '';
  const w = Math.max(1, width);
  const h = Math.max(2, height);
  const min = Math.min(...v);
  const max = Math.max(...v);
  const flat = max === min;
  const span = max - min || 1;
  const inset = 1;
  const n = v.length;
  return v
    .map((val, i) => {
      const x = n === 1 ? 0 : (i / (n - 1)) * w;
      // a flat series sits on the vertical centre instead of hugging the floor
      const y = flat ? h / 2 : h - inset - ((val - min) / span) * (h - inset * 2);
      const pts = [`${round(x)},${round(y)}`];
      if (n === 1) pts.push(`${w},${round(y)}`);
      return pts.join(' ');
    })
    .join(' ');
}

function round(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Inline SVG sparkline. Empty input renders an empty placeholder box so
 * layouts do not jump when data arrives.
 */
export function sparkline(
  values,
  { width = 120, height = 32, tone = 'accent', fill = true, class: cls } = {}
) {
  const pts = sparklinePath(values, width, height);
  if (!pts) {
    return `<svg class="${cx('ui-sparkline', 'ui-sparkline-empty', cls)}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`;
  }
  const first = pts.split(' ')[0].split(',')[0];
  const last = pts.split(' ').pop().split(',')[0];
  const area = fill
    ? `<polygon class="ui-sparkline-area" points="${first},${height} ${pts} ${last},${height}"/>`
    : '';
  return `<svg class="${cx('ui-sparkline', `ui-sparkline-${tone}`, cls)}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${area}<polyline class="ui-sparkline-line" points="${pts}" fill="none"/></svg>`;
}

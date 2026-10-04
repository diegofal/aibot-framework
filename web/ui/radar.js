import { cx, esc } from './escape.js';

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Polygon vertices for `axes` (`[{ label, value }]`, value in 0..1) on a
 * radar of the given `size`. The first axis points straight up; the rest
 * follow clockwise. Returns [] for fewer than three axes.
 */
export function radarPoints(axes, size = 160, radius = size * 0.38) {
  if (!Array.isArray(axes) || axes.length < 3) return [];
  const cx0 = size / 2;
  const cy0 = size / 2;
  const n = axes.length;
  return axes.map((a, i) => {
    const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const r = clamp01(a?.value) * radius;
    return [round(cx0 + r * Math.cos(angle)), round(cy0 + r * Math.sin(angle))];
  });
}

function round(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Inline SVG radar chart with four rings, axis spokes, labels and one filled
 * polygon. Needs at least three axes; otherwise renders an empty box.
 */
export function radar(axes, { size = 160, tone = 'accent', class: cls } = {}) {
  const pts = radarPoints(axes, size);
  if (pts.length === 0) {
    return `<svg class="${cx('ui-radar', 'ui-radar-empty', cls)}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"></svg>`;
  }
  const c = size / 2;
  const radius = size * 0.38;
  const n = axes.length;
  const rings = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const ring = axes
        .map((_, i) => {
          const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
          return `${round(c + f * radius * Math.cos(angle))},${round(c + f * radius * Math.sin(angle))}`;
        })
        .join(' ');
      return `<polygon class="ui-radar-ring" points="${ring}"/>`;
    })
    .join('');
  const spokes = axes
    .map((_, i) => {
      const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
      return `<line class="ui-radar-spoke" x1="${c}" y1="${c}" x2="${round(
        c + radius * Math.cos(angle)
      )}" y2="${round(c + radius * Math.sin(angle))}"/>`;
    })
    .join('');
  const labels = axes
    .map((a, i) => {
      const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const lr = radius + size * 0.09;
      const x = round(c + lr * Math.cos(angle));
      const y = round(c + lr * Math.sin(angle));
      const anchor =
        Math.abs(Math.cos(angle)) < 0.2 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end';
      return `<text class="ui-radar-label" x="${x}" y="${y}" dy="0.35em" text-anchor="${anchor}">${esc(
        a?.label ?? ''
      )}</text>`;
    })
    .join('');
  const poly = pts.map(([x, y]) => `${x},${y}`).join(' ');
  return `<svg class="${cx('ui-radar', `ui-radar-${tone}`, cls)}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">${rings}${spokes}<polygon class="ui-radar-shape" points="${poly}"/>${labels}</svg>`;
}

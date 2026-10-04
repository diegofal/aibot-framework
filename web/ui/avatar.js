import { cx, esc } from './escape.js';

/** Stable 32-bit hash (FNV-1a) of a string. */
export function hashSeed(seed) {
  let h = 0x811c9dc5;
  const s = String(seed ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Hue in [0, 360) derived from the seed. Same seed, same hue, forever. */
export function avatarHue(seed) {
  return hashSeed(seed) % 360;
}

/** Up to two initials from a display name ("job seeker" → "JS"). */
export function initials(name) {
  const words = String(name ?? '')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Round avatar. With `src` it is an image; otherwise a deterministic
 * gradient disc with initials, derived from `seed` (defaults to `name`).
 * `status` (ok/warn/danger/info/muted) adds a presence dot.
 */
export function avatar({ seed, name, src, size = 40, status, class: cls, title } = {}) {
  const s = Math.max(16, Number(size) || 40);
  const label = esc(title ?? name ?? '');
  const dot = status ? `<span class="ui-avatar-dot ui-avatar-dot-${esc(status)}"></span>` : '';
  const style = `width:${s}px;height:${s}px`;
  if (src) {
    return `<span class="${cx('ui-avatar', cls)}" style="${style}" title="${label}"><img src="${esc(
      src
    )}" alt="${label}">${dot}</span>`;
  }
  const hue = avatarHue(seed ?? name ?? '');
  const hue2 = (hue + 40) % 360;
  const text = initials(name ?? seed);
  const fontSize = Math.round(s * 0.42);
  return `<span class="${cx('ui-avatar', cls)}" style="${style}" title="${label}"><svg viewBox="0 0 100 100" width="${s}" height="${s}" role="img" aria-label="${label}"><defs><linearGradient id="g${hue}-${hue2}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 55%)"/><stop offset="1" stop-color="hsl(${hue2} 70% 40%)"/></linearGradient></defs><circle cx="50" cy="50" r="50" fill="url(#g${hue}-${hue2})"/><text x="50" y="50" dy="0.36em" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-weight="600" font-size="${Math.round(
    (fontSize / s) * 100
  )}" fill="#fff">${esc(text)}</text></svg>${dot}</span>`;
}

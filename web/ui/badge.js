import { cx, esc } from './escape.js';

export const BADGE_TONES = ['ok', 'warn', 'danger', 'info', 'muted', 'accent'];

/** Map a free-form status word to a badge tone. Unknown words fall back to `muted`. */
export function toneFor(status) {
  const s = String(status ?? '').toLowerCase();
  if (['ok', 'running', 'active', 'approved', 'completed', 'success', 'healthy'].includes(s))
    return 'ok';
  if (['warn', 'warning', 'pending', 'standby', 'unreviewed', 'draining', 'idle'].includes(s))
    return 'warn';
  if (['error', 'failed', 'blocked', 'rejected', 'stopped', 'revoked', 'danger'].includes(s))
    return 'danger';
  if (['info', 'checked', 'working', 'submitted'].includes(s)) return 'info';
  if (['accent', 'mcp', 'a2a'].includes(s)) return 'accent';
  return 'muted';
}

/**
 * Small status pill. `text` is escaped. `tone` is one of BADGE_TONES;
 * anything else falls back to `muted`. `opts.dot` adds a leading dot.
 */
export function badge(text, tone = 'muted', opts = {}) {
  const t = BADGE_TONES.includes(tone) ? tone : 'muted';
  const dot = opts.dot ? '<span class="ui-badge-dot"></span>' : '';
  const title = opts.title ? ` title="${esc(opts.title)}"` : '';
  return `<span class="${cx('ui-badge', `ui-badge-${t}`, opts.class)}"${title}>${dot}${esc(text)}</span>`;
}

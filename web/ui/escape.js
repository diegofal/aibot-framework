/**
 * HTML escaping for the UI component layer.
 *
 * Kept separate from `pages/shared.js` so `web/ui/*` can be imported from
 * Bun tests without touching the DOM.
 */
export function esc(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Join class names, skipping empties. */
export function cx(...names) {
  return names.filter(Boolean).join(' ');
}

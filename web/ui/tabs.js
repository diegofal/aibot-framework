import { cx, esc } from './escape.js';

/**
 * Horizontal tab strip. `items` are `{ id, label, href?, badge? }`; the one
 * whose `id` equals `activeId` is marked active. Without `href` a tab is a
 * button carrying `data-tab="<id>"` so the page can wire clicks.
 */
export function tabs(items, activeId, { class: cls } = {}) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const inner = items
    .map((it) => {
      const active = it.id === activeId;
      const badge =
        it.badge != null && it.badge !== 0 && it.badge !== ''
          ? `<span class="ui-tab-badge">${esc(it.badge)}</span>`
          : '';
      const classes = cx('ui-tab', active ? 'active' : '');
      const aria = active ? ' aria-current="page"' : '';
      if (it.href) {
        return `<a class="${classes}" href="${esc(it.href)}"${aria}>${esc(it.label)}${badge}</a>`;
      }
      return `<button type="button" class="${classes}" data-tab="${esc(it.id)}"${aria}>${esc(
        it.label
      )}${badge}</button>`;
    })
    .join('');
  return `<nav class="${cx('ui-tabs', cls)}" role="tablist">${inner}</nav>`;
}

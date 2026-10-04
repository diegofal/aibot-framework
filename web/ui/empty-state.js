import { cx, esc } from './escape.js';

/**
 * Friendly placeholder for a list with nothing in it yet.
 * `icon`, `title` and `hint` are escaped; `action` is trusted HTML (a button).
 */
export function emptyState({
  icon = '·',
  title = 'Nothing here yet',
  hint,
  action,
  class: cls,
} = {}) {
  return `<div class="${cx('ui-empty', cls)}"><div class="ui-empty-icon" aria-hidden="true">${esc(
    icon
  )}</div><div class="ui-empty-title">${esc(title)}</div>${
    hint ? `<div class="ui-empty-hint">${esc(hint)}</div>` : ''
  }${action ? `<div class="ui-empty-action">${action}</div>` : ''}</div>`;
}

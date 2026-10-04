import { esc } from './escape.js';

/**
 * Pure markup for a right-hand side panel. `title` is escaped; `body` and
 * `footer` are trusted HTML.
 */
export function sheetMarkup({ title = '', body = '', footer = '', wide = false } = {}) {
  return `<div class="ui-sheet-backdrop" data-sheet-close></div><aside class="ui-sheet${
    wide ? ' ui-sheet-wide' : ''
  }" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="ui-sheet-head"><div class="ui-sheet-title">${esc(
    title
  )}</div><button type="button" class="ui-sheet-close" data-sheet-close aria-label="Close">×</button></header><div class="ui-sheet-body">${body}</div>${
    footer ? `<footer class="ui-sheet-foot">${footer}</footer>` : ''
  }</aside>`;
}

let escHandler = null;

/** Open a sheet. Returns its body element for the caller to wire events. */
export function openSheet(opts = {}) {
  if (typeof document === 'undefined') return null;
  closeSheet();
  const root = document.createElement('div');
  root.id = 'ui-sheet-root';
  root.innerHTML = sheetMarkup(opts);
  document.body.appendChild(root);
  document.body.classList.add('ui-sheet-open');
  root
    .querySelectorAll('[data-sheet-close]')
    .forEach((el) => el.addEventListener('click', closeSheet));
  escHandler = (e) => {
    if (e.key === 'Escape') closeSheet();
  };
  document.addEventListener('keydown', escHandler);
  requestAnimationFrame(() => root.classList.add('show'));
  return root.querySelector('.ui-sheet-body');
}

export function closeSheet() {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('ui-sheet-root');
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
  document.body.classList.remove('ui-sheet-open');
  if (root) root.remove();
}

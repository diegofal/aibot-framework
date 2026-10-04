/**
 * Row overflow menu (session S3.5 of docs/plans/jarvis-fleet-plan.md).
 *
 * A native `<details>` so it opens and closes without JS; `initMenus()` only
 * adds the click-away/Escape behaviour and keeps a single menu open. Items
 * are `<button data-action data-id>` so the page's existing event delegation
 * on `button[data-action]` keeps working unchanged, or `<a href>` for links.
 *
 *   rowMenu([
 *     { label: 'Edit', action: 'edit', id: 'b1', title: '…' },
 *     { separator: true },
 *     { label: 'Open', href: '#/agents/b1' },
 *     { label: 'Delete', action: 'delete', id: 'b1', danger: true },
 *   ])
 */
import { esc } from './escape.js';

function itemMarkup(item) {
  if (item.separator) return '<hr class="ui-menu-sep">';
  const cls = `ui-menu-item${item.danger ? ' ui-menu-danger' : ''}`;
  const title = item.title ? ` title="${esc(item.title)}"` : '';
  if (item.href) {
    return `<a class="${cls}" role="menuitem" href="${esc(item.href)}"${title}>${esc(item.label)}</a>`;
  }
  const id = item.id != null ? ` data-id="${esc(String(item.id))}"` : '';
  const disabled = item.disabled ? ' disabled' : '';
  return `<button type="button" class="${cls}" role="menuitem" data-action="${esc(
    item.action ?? ''
  )}"${id}${title}${disabled}>${esc(item.label)}</button>`;
}

/** `''` when there is no real item (separators alone do not count). */
export function rowMenu(items, { label = 'More actions' } = {}) {
  const list = (items ?? []).filter(Boolean);
  if (!list.some((i) => !i.separator)) return '';
  // Leading/trailing/double separators are dropped so the menu never opens on a rule.
  const cleaned = [];
  for (const it of list) {
    if (it.separator && (cleaned.length === 0 || cleaned[cleaned.length - 1].separator)) continue;
    cleaned.push(it);
  }
  while (cleaned.length && cleaned[cleaned.length - 1].separator) cleaned.pop();
  return `<details class="ui-menu"><summary class="btn btn-sm ui-menu-btn" aria-label="${esc(
    label
  )}" title="${esc(label)}">&#8943;</summary><div class="ui-menu-list" role="menu">${cleaned
    .map(itemMarkup)
    .join('')}</div></details>`;
}

/**
 * One open menu at a time; click outside, Escape, or picking an item closes
 * it. Returns a cleanup function. No-op without a DOM.
 */
export function initMenus(root) {
  if (typeof document === 'undefined') return () => {};
  const scope = root ?? document;
  const onToggle = (e) => {
    const menu = e.target;
    if (!(menu instanceof HTMLElement) || !menu.classList.contains('ui-menu') || !menu.open) return;
    for (const other of scope.querySelectorAll('details.ui-menu[open]')) {
      if (other !== menu) other.removeAttribute('open');
    }
  };
  const onClick = (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const inside = target?.closest('details.ui-menu');
    for (const open of scope.querySelectorAll('details.ui-menu[open]')) {
      // A click on an item closes the menu after the page's own handler ran.
      if (open !== inside || target?.closest('.ui-menu-item')) open.removeAttribute('open');
    }
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    for (const open of scope.querySelectorAll('details.ui-menu[open]'))
      open.removeAttribute('open');
  };
  scope.addEventListener('toggle', onToggle, true);
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  return () => {
    scope.removeEventListener('toggle', onToggle, true);
    document.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey);
  };
}

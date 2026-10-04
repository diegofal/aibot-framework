/**
 * One "select all" control for every multi-select list (Needs You, Work,
 * Skills…): a tri-state checkbox that selects the visible rows, or clears
 * them when they are all selected. Rows outside the current filter keep
 * their selection either way.
 *
 * `selectAllBox` is pure markup; `syncSelectAll(root)` sets the
 * `indeterminate` property, which HTML attributes cannot express.
 */
import { esc } from './escape.js';

const asSet = (selected) => (selected instanceof Set ? selected : new Set(selected ?? []));

/** 'none' | 'some' | 'all' for the visible ids against the selection. */
export function selectAllState(visibleIds, selected) {
  const ids = [...(visibleIds ?? [])];
  if (ids.length === 0) return 'none';
  const set = asSet(selected);
  const n = ids.filter((id) => set.has(id)).length;
  if (n === 0) return 'none';
  return n === ids.length ? 'all' : 'some';
}

/** The next selection: all visible added, or all visible removed when already all selected. */
export function toggleAll(visibleIds, selected) {
  const next = new Set(asSet(selected));
  const ids = [...(visibleIds ?? [])];
  if (selectAllState(ids, next) === 'all') for (const id of ids) next.delete(id);
  else for (const id of ids) next.add(id);
  return next;
}

/** Labelled tri-state checkbox; '' when there is nothing to select. */
export function selectAllBox({ id, state = 'none', count = 0 } = {}) {
  if (!count) return '';
  const label = state === 'all' ? 'Unselect all' : `Select all ${Number(count)}`;
  return `<label class="select-all" title="${esc(label)}"><input type="checkbox" id="${esc(
    id
  )}" data-state="${esc(state)}"${state === 'all' ? ' checked' : ''}> <span>${esc(label)}</span></label>`;
}

/** Applies the partial state to every select-all box under `root`. */
export function syncSelectAll(root) {
  for (const box of root?.querySelectorAll?.('input[type="checkbox"][data-state]') ?? []) {
    box.indeterminate = box.dataset.state === 'some';
  }
}

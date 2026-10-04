/**
 * The selection toolbar every multi-select list uses (Needs You, Work,
 * Skills, Tools): a tri-state "select all" box lined up with the row
 * checkboxes, the count, and the page's bulk actions in place once
 * something is selected. Same look and same behaviour on every screen;
 * each page only says which actions apply to its selection.
 *
 * Pure markup plus `syncSelectAll(root)`, which sets `indeterminate`
 * (HTML attributes cannot express it).
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

const TONE_CLASS = { primary: ' btn-primary', danger: ' btn-danger' };

function actionButton(a) {
  const n = Number(a.count) || 0;
  const title = a.title ? ` title="${esc(a.title)}"` : '';
  return `<button type="button" class="btn btn-sm${TONE_CLASS[a.tone] ?? ''}" data-bulk="${esc(
    a.id
  )}"${title}>${esc(a.label)} ${n}</button>`;
}

/**
 * `{ id, visibleIds, selected, actions, idle, noun }` → toolbar markup; ''
 * when the list is empty. The checkbox is `#<id>-all`; every action button
 * carries `data-bulk="<action id>"`, Clear is `data-bulk="clear"`.
 * `actions`: `[{ id, label, count, tone?: 'primary'|'danger', title? }]`,
 * shown only while something is selected and only when `count > 0`.
 * `idle`: extra markup for the right side when nothing is selected.
 */
export function bulkToolbar({
  id,
  visibleIds = [],
  selected = [],
  actions = [],
  idle = '',
  noun = 'item',
} = {}) {
  const ids = [...visibleIds];
  const total = ids.length;
  if (total === 0) return '';
  const set = asSet(selected);
  const count = ids.filter((v) => set.has(v)).length;
  const state = selectAllState(ids, set);
  const plural = total === 1 ? noun : `${noun}s`;
  const label =
    count === 0
      ? `<span class="bulk-toolbar-hint">Select all</span><span class="bulk-toolbar-total">${total} ${esc(
          plural
        )}</span>`
      : `<span class="bulk-toolbar-count">${state === 'all' ? `All ${total}` : `${count} of ${total}`} selected</span>`;
  const right =
    count === 0
      ? idle
      : `${actions
          .filter((a) => Number(a.count) > 0)
          .map(actionButton)
          .join(
            ''
          )}<button type="button" class="btn btn-sm" data-bulk="clear" title="Clear selection (Esc)">Clear</button>`;
  const what = state === 'all' ? 'Unselect all' : 'Select all';
  return `<div class="bulk-toolbar${count > 0 ? ' has-selection' : ''}" role="toolbar" aria-label="Selection">
  <label class="bulk-toolbar-select" title="${what}"><input type="checkbox" id="${esc(
    id
  )}-all" data-state="${state}" aria-label="${what}"${state === 'all' ? ' checked' : ''}>${label}</label>
  <div class="bulk-toolbar-actions">${right}</div>
</div>`;
}

/** Applies the partial state to every select-all box under `root`. */
export function syncSelectAll(root) {
  for (const box of root?.querySelectorAll?.('input[type="checkbox"][data-state]') ?? []) {
    box.indeterminate = box.dataset.state === 'some';
  }
}

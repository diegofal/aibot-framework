/**
 * Productions explorer: logic shared by the all-bots view and the single-bot
 * view in `productions.js` (UX overhaul, docs/plans/ux-overhaul-plan.md).
 * Pure functions only — no DOM, no network — so `tests/web/productions-helpers.test.ts`
 * can cover them. Request builders return `{ url, method, body }` for `api()`.
 */
import { esc } from '../ui/index.js';

const enc = encodeURIComponent;

/** Unique key for a selectable tree item. */
export function selKey(botId, path) {
  return `${botId}\0${path}`;
}

/** The file to open from the hash query: `?file=`, or the legacy `?path=` alias. */
export function readFileParam(params) {
  return String(params?.file || params?.path || '');
}

/** Canonical hash for the explorer (all-bots, or `single` = the bot's own view). */
export function prodHash({ botId = '', file = '', single = false } = {}) {
  if (single && botId) {
    const base = `#/work/productions/${enc(botId)}`;
    return file ? `${base}?file=${enc(file)}` : base;
  }
  if (botId && file) return `#/work/productions?bot=${enc(botId)}&file=${enc(file)}`;
  return '#/work/productions';
}

/** Tree filter: free-text search over name/path + review status. Dirs match through children. */
export function matchesProductionFilters(node, { search = '', status = '' } = {}) {
  if (!node) return false;
  if (node.type === 'dir') {
    if (!search && !status) return true;
    return node.children?.some((c) => matchesProductionFilters(c, { search, status })) ?? false;
  }
  if (search) {
    const q = search.toLowerCase();
    const name = String(node.name ?? '').toLowerCase();
    const path = String(node.path ?? '').toLowerCase();
    if (!name.includes(q) && !path.includes(q)) return false;
  }
  if (status) {
    const s = node.evaluation?.status;
    if (status === 'checked' && !node.coherenceCheck) return false;
    if (status === 'unreviewed' && s) return false;
    if (status === 'approved' && s !== 'approved') return false;
    if (status === 'rejected' && s !== 'rejected') return false;
  }
  return true;
}

/**
 * Flat, ordered list of the visible selectable items: `{ botId, path, type, entryId? }`.
 * `topLevel` (all-bots view) is the root array whose dir nodes are bot folders:
 * those are not selectable, their `path` is the botId, and their expand key is
 * the bare botId (nested dirs use `<botId>/<path>`). Without `topLevel`
 * (single-bot view) every dir's expand key is its path.
 */
export function collectVisibleItems(
  nodes,
  { botId = null, expandedDirs = new Set(), matchesFilters = () => true, topLevel = null } = {}
) {
  const items = [];
  for (const node of nodes || []) {
    if (!matchesFilters(node)) continue;
    if (node.type === 'dir') {
      const isTop = !!topLevel?.includes(node);
      const bot = isTop ? node.path : botId;
      const expandKey = !topLevel ? node.path : isTop ? node.path : `${bot}/${node.path}`;
      if (!isTop) items.push({ botId: bot, path: node.path, type: 'dir' });
      if (expandedDirs.has(expandKey) && node.children) {
        items.push(
          ...collectVisibleItems(node.children, {
            botId: bot,
            expandedDirs,
            matchesFilters,
            topLevel,
          })
        );
      }
    } else {
      items.push({ botId, path: node.path, type: 'file', entryId: node.entryId });
    }
  }
  return items;
}

/** Keys of the inclusive range between two visible items (shift-click). */
export function rangeKeys(visible, fromKey, toKey) {
  const keys = (visible ?? []).map((v) => selKey(v.botId, v.path));
  const a = keys.indexOf(fromKey);
  const b = keys.indexOf(toKey);
  if (a === -1 || b === -1) return [];
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** What a delete confirmation names. */
export function deleteLabel(items) {
  const list = items ?? [];
  if (list.length !== 1) return `${list.length} items`;
  const [it] = list;
  return it.type === 'dir' ? `folder "${it.path}" and all its contents` : `file "${it.path}"`;
}

const TRACKED_ACTIONS = new Set(['approve', 'reject', 'archive']);

/**
 * Which selected items a bulk action applies to. Approve / reject / archive
 * go through the changelog entry, so they need a tracked file (`entryId`);
 * delete works on any file or folder by path.
 */
export function bulkPlan(items, action) {
  const list = items ?? [];
  let targets = [];
  if (TRACKED_ACTIONS.has(action)) targets = list.filter((i) => i.type === 'file' && i.entryId);
  else if (action === 'delete') targets = [...list];
  return { targets, skipped: list.length - targets.length };
}

/** `{ url, method, body }` for one productions action, or null. */
export function prodRequest(action, { botId, entryId, path, rating, reason } = {}) {
  const base = `/api/productions/${enc(String(botId ?? ''))}`;
  const entry = `${base}/${enc(String(entryId ?? ''))}`;
  if (action === 'approve' || action === 'reject') {
    const body = { status: action === 'approve' ? 'approved' : 'rejected' };
    if (rating) body.rating = rating;
    return { url: `${entry}/evaluate`, method: 'POST', body };
  }
  if (action === 'archive') {
    return {
      url: `${entry}/archive`,
      method: 'POST',
      body: { reason: String(reason ?? '').trim() || 'Archived from dashboard' },
    };
  }
  if (action === 'delete-entry') return { url: entry, method: 'DELETE', body: undefined };
  if (action === 'delete') {
    return { url: `${base}/delete-by-path`, method: 'POST', body: { path } };
  }
  return null;
}

/** Bulk bar for the tree's multi-selection; empty when nothing is selected. */
export function productionsBulkBar({ count = 0, tracked = 0 } = {}) {
  if (!count) return '';
  const dis =
    tracked > 0 ? '' : ' disabled title="None of the selected items is tracked in the changelog"';
  return `<div class="prod-bulk-bar" role="toolbar" aria-label="Bulk actions">
    <span class="prod-bulk-count">${Number(count)} selected</span>
    <button type="button" class="btn btn-sm" data-prod-bulk="approve"${dis}>Approve ${Number(tracked)}</button>
    <button type="button" class="btn btn-sm" data-prod-bulk="reject"${dis}>Reject ${Number(tracked)}</button>
    <button type="button" class="btn btn-sm" data-prod-bulk="archive"${dis}>Archive ${Number(tracked)}</button>
    <button type="button" class="btn btn-sm btn-danger" data-prod-bulk="delete">Delete ${Number(count)}</button>
    <button type="button" class="btn btn-sm" data-prod-bulk="clear" title="Clear selection">${esc('Clear')}</button>
  </div>`;
}

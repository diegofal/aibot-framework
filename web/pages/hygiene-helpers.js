/**
 * Hygiene history paging. `GET /api/hygiene/history` only takes `limit` and
 * the store keeps the last 500 runs (`HYGIENE_HISTORY_LIMIT`), so "Load more"
 * re-asks with a bigger limit. Pure; covered by `tests/web/activity-helpers.test.ts`.
 */
export const HISTORY_PAGE = 50;
export const HISTORY_MAX = 500;

/** A full page under the store cap means there may be more. */
export function historyHasMore(count, limit, max = HISTORY_MAX) {
  return count >= limit && limit < max;
}

export function nextHistoryLimit(limit, page = HISTORY_PAGE, max = HISTORY_MAX) {
  return Math.min(max, (Number(limit) || 0) + page);
}

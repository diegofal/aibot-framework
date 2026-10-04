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

/**
 * What is still open after a run. An apply run's `findings` are the state
 * *before* the fixes; its `remaining` is a fresh preview taken after them.
 * Runs recorded before `remaining` existed fall back to `findings`.
 */
export function openFindings(run) {
  if (!run) return [];
  if (!run.dryRun && Array.isArray(run.remaining)) return run.remaining;
  return Array.isArray(run.findings) ? run.findings : [];
}

/**
 * Applied fixes grouped by bot, each joined with the finding it fixed.
 * `all` runs prefix every id with `<botId>:` or `fleet:`; single-routine runs
 * do not, so they fall back to the run's own bot.
 */
export function cleanedByBot(run) {
  const byId = new Map((run?.findings || []).map((f) => [f.id, f]));
  const groups = new Map();
  for (const a of run?.applied || []) {
    const f = byId.get(a.findingId);
    const botId = f?.botId || (run.botId ?? String(a.findingId || '').split(':')[0]) || 'fleet';
    if (!groups.has(botId)) groups.set(botId, []);
    groups.get(botId).push({
      action: a.action,
      result: a.result,
      file: f?.file ?? null,
      kind: f?.kind ?? null,
      message: f?.message ?? '',
    });
  }
  return [...groups].map(([botId, items]) => ({ botId, items }));
}

export function cleanupHeadline(run) {
  const cleaned = (run?.applied || []).length;
  const left = (Array.isArray(run?.remaining) ? run.remaining : []).length;
  const leftText = left === 1 ? '1 still needs you' : `${left} still need you`;
  if (cleaned === 0) {
    return left === 0
      ? 'Nothing to clean up — everything is tidy'
      : `Nothing to clean up · ${leftText}`;
  }
  return `Cleaned up ${cleaned} item${cleaned === 1 ? '' : 's'}${left ? ` · ${leftText}` : ''}`;
}

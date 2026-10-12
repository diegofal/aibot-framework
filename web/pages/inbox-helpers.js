/**
 * Inbox thread — pure helpers for `inbox.js` (no DOM, no network), covered
 * by `tests/web/inbox-helpers.test.ts`.
 */
import { whyPanel } from './why-helpers.js';

/**
 * The ask's "Why this?" under the thread header: `why` comes from
 * `GET /api/conversations/:botId/:id` (ask_human threads only). None, no fold.
 */
export function threadWhy(why, { botId, nowMs = Date.now() } = {}) {
  const panel = whyPanel(why, { nowMs, botId });
  return panel ? `<div class="inbox-why">${panel}</div>` : '';
}

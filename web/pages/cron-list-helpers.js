/**
 * Cron pieces shared by the board (`cron-board-helpers.js`), the job page and
 * the command palette: the agent of a job, relative times, the name without
 * its "[botId]" suffix, API list / error states, re-run summary and the
 * job / run Why folds. `tests/web/cron-list-helpers.test.ts` covers them.
 */
import { emptyState } from '../ui/index.js';
import { whyPanel } from './why-helpers.js';

export function jobAgentId(job) {
  const id = job?.payload?.botId;
  return id ? String(id) : null;
}

/** "in 9h" / "5m ago" / '' when unknown. */
export function inWords(ts, nowMs = Date.now()) {
  const t = ts == null ? Number.NaN : typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const diff = t - nowMs;
  const abs = Math.abs(diff);
  let words;
  if (abs < 60_000) words = 'now';
  else if (abs < 3_600_000) words = `${Math.round(abs / 60_000)}m`;
  else if (abs < 172_800_000) words = `${Math.round(abs / 3_600_000)}h`;
  else words = `${Math.round(abs / 86_400_000)}d`;
  if (words === 'now') return diff >= 0 ? 'now' : 'just now';
  return diff > 0 ? `in ${words}` : `${words} ago`;
}

/** Removes a trailing "[<botId>]" the skill scheduler appends to job names. */
export function displayName(job) {
  const name = String(job?.name ?? job?.id ?? '');
  const botId = jobAgentId(job);
  if (!botId) return name;
  return name.replace(
    new RegExp(`\\s*\\[${botId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`),
    ''
  );
}

/** `{ list, error }` from an `api()` response that should have been an array. */
export function apiList(res) {
  if (Array.isArray(res)) return { list: res, error: null };
  const error =
    res && typeof res === 'object' && res.error ? String(res.error) : 'Unexpected response';
  return { list: [], error };
}

/** Error panel with a Retry button (`data-action="retry"`). */
export function cronErrorState(message, title = 'Could not load cron jobs') {
  return emptyState({
    icon: '!',
    title,
    hint: String(message ?? ''),
    action: '<button class="btn btn-sm" data-action="retry">Retry</button>',
    class: 'ops-error-state',
  });
}

/**
 * Toast for `POST /api/cron/rerun-failed` (`{ attempted, results: [{ ran }] }`).
 * Shared by the Cron page's "Re-run failed" button and the palette action.
 */
export function rerunSummary(res) {
  if (!res || res.error) {
    return { text: `Re-run failed: ${res?.error ?? 'no response'}`, tone: 'danger' };
  }
  const results = Array.isArray(res.results) ? res.results : [];
  const succeeded = results.filter((r) => r?.ran).length;
  const attempted = Number(res.attempted) || 0;
  return { text: `Re-ran ${succeeded}/${attempted}`, tone: succeeded ? 'ok' : 'danger' };
}

// ── Why this? (Why row 16) ───────────────────────────────────────────────────
// The server attaches `why` to each job (`cronJobToWhy`: who set it up, the
// cycle and goal behind it, the schedule in words) and to each run
// (`cronRunToWhy`: which job, when, how it went). Pages only render it.

/** The job detail's "Why this?" block; empty when the server sent none. */
export function jobWhySection(job, nowMs = Date.now()) {
  const panel = whyPanel(job?.why, { nowMs, botId: jobAgentId(job) ?? undefined });
  return panel ? `<div class="detail-card cron-why">${panel}</div>` : '';
}

/** One run's fold, as a table cell (empty for runs logged without one). */
export function runWhyCell(run, nowMs = Date.now()) {
  return `<td class="cron-run-why">${whyPanel(run?.why, { nowMs })}</td>`;
}

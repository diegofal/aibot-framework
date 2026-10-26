/**
 * Watcher page, autonomy rung 0 (pure half; `docs/plans/watcher-autonomy-plan.md`):
 * the hard-kill banner (C1), the month spend against its ceiling (C6) and the
 * Proposals panel — pending proposals, the queue and the change history with
 * two-step Approve / Revert (C3, C4, C7). Data in, HTML string out: no DOM,
 * so `tests/web/watcher-autonomy-helpers.test.ts` runs it under Bun.
 *
 * Data: `WatcherState.killed` / `.month` (`GET /api/watcher`, `watcher:state`)
 * and `GET /api/watcher/proposals` (`ProposalsResponse` in
 * `src/watcher/autonomy/types.ts`). Approve sends the `contentHash` the
 * Approve button was rendered with (`data-content-hash`): the hash of exactly
 * the card the operator read.
 */
import { esc } from '../ui/index.js';

/** A two-step button stays armed this long after its first click. */
export const ARM_MS = 4000;

const AMBER_AT = 0.75;

function relTime(iso, nowMs) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const abs = Math.max(0, nowMs - t);
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min ago`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} h ago`;
  return `${Math.round(abs / 86_400_000)} d ago`;
}

const money = (n) => `$${(Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2)}`;

/* ── Header: kill banner and month spend ─────────────────────────── */

const KILL_SOURCE = {
  env: 'environment: AIBOT_WATCHER_KILL',
  file: 'file: watcher-kill in the data folder',
};

/** The red banner while the hard kill is on (C1); '' otherwise. */
export function killBannerHtml(killed, nowMs = Date.now()) {
  if (!killed || typeof killed !== 'object') return '';
  const source = KILL_SOURCE[killed.source] ?? `source: ${String(killed.source ?? 'unknown')}`;
  const when = relTime(killed.since, nowMs);
  return `<div class="watcher-auto-kill" role="alert"><strong>Stopped by the hard kill (${esc(
    source
  )})</strong>${
    when
      ? ` <span class="watcher-auto-kill-since" title="${esc(killed.since)}">· ${esc(when)}</span>`
      : ''
  }<div>Nothing runs until it is cleared and you start the watcher again.</div></div>`;
}

/** The Start button is disabled while killed; a running watcher's Stop never is. */
export function startBlockedByKill(state) {
  return !!state?.killed && !state?.running;
}

/** While the kill banner shows, the page re-reads `GET /api/watcher` this often. */
export const KILL_POLL_MS = 10_000;

/**
 * Re-read the state on a timer? Only while the kill banner shows: nothing
 * publishes `watcher:state` while the watcher is stopped, so without it
 * clearing the switch leaves Start disabled until a reload. The re-read only
 * updates the page; it never starts the watcher.
 */
export function needsKillPoll(state) {
  return !!state?.killed && typeof state.killed === 'object';
}

/**
 * The watcher-off screen plus the Proposals host (and the month spend, when
 * the off answer carries one): proposals and the change ledger work without
 * the watcher, so an applied change stays revertable from here.
 */
export function watcherOffHtml(offHtml, state) {
  const month = monthSpendHtml(state?.month);
  return `${offHtml}${
    month ? `<div class="watcher-off-month">${month}</div>` : ''
  }<section class="watcher-autonomy watcher-off-autonomy" id="watcher-proposals" aria-label="Proposals" hidden></section>`;
}

/** `{ text, tone: ok | warn | over, share }` for the month spend (C6), or null without one. */
export function monthSpend(month) {
  if (!month || typeof month !== 'object') return null;
  const cost = Number(month.costUsd);
  const ceiling = Number(month.ceilingUsd);
  if (!Number.isFinite(cost) || !Number.isFinite(ceiling)) return null;
  const share = ceiling > 0 ? cost / ceiling : 1;
  const tone = share >= 1 ? 'over' : share >= AMBER_AT ? 'warn' : 'ok';
  const text = `this month ${money(cost)} of ${money(ceiling)}${
    tone === 'over' ? ' · ceiling reached: every call is refused' : ''
  }`;
  return { text, tone, share };
}

export function monthSpendHtml(month) {
  const m = monthSpend(month);
  if (!m) return '';
  const cls = m.tone === 'ok' ? '' : ` is-${m.tone}`;
  return `<div class="watcher-auto-month${cls}" title="The watcher's spend this UTC month against its monthly ceiling">${esc(
    m.text
  )}</div>`;
}

/* ── Proposals ───────────────────────────────────────────────────── */

/** Is this watcher log row about autonomy (`autonomy:*`)? The page refetches proposals on one. */
export function isAutonomyRow(row) {
  const op = row?.op ?? row?.type;
  return typeof op === 'string' && op.startsWith('autonomy:');
}

/**
 * A click on a two-step button. `armed` is `{ key, until }` or null. The first
 * click on a key arms it (`fire: false`); a second one before `until` fires
 * and disarms. A click on another key re-arms on that key.
 */
export function armClick(armed, key, nowMs = Date.now()) {
  if (isArmed(armed, key, nowMs)) return { fire: true, armed: null };
  return { fire: false, armed: { key, until: nowMs + ARM_MS } };
}

export function isArmed(armed, key, nowMs = Date.now()) {
  return !!armed && armed.key === key && Number(armed.until) > nowMs;
}

/** A config value as written: strings bare, the rest as JSON. */
export function formatValue(v) {
  if (v === undefined) return '(unset)';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** The guard in plain words. */
export function guardText(guard) {
  if (!guard || typeof guard !== 'object') return 'No guard recorded.';
  const move = guard.direction === 'max' ? 'rises above' : 'falls below';
  return `If ${guard.metric} ${move} ${guard.bound} within ${guard.windowHours} h of applying, code rolls it back by itself.`;
}

export function expiresText(iso, nowMs = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const left = t - nowMs;
  if (left <= 0) return 'expired';
  if (left < 3_600_000) return `expires in ${Math.max(1, Math.round(left / 60_000))} min`;
  if (left < 48 * 3_600_000) return `expires in ${Math.round(left / 3_600_000)} h`;
  return `expires in ${Math.round(left / 86_400_000)} d`;
}

const KIND_WORDS = {
  threshold: 'Watcher setting',
  'fleet-cadence': 'Agent cadence',
  'prompt-section': 'Prompt section',
};

const timeOf = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : 0;
};

/**
 * Pending (oldest first: the first to expire), queued (oldest first) and
 * decided (rejected / expired, newest first). `rejected-locked` is never
 * shown (C2); an approved proposal lives on as its change record.
 */
export function orderProposals(proposals) {
  const list = Array.isArray(proposals) ? proposals.filter((p) => p && typeof p === 'object') : [];
  const by = (status) => list.filter((p) => p.status === status);
  const oldest = (a, b) => timeOf(a.pendingAt ?? a.createdAt) - timeOf(b.pendingAt ?? b.createdAt);
  return {
    pending: by('pending').sort(oldest),
    queued: by('queued').sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt)),
    decided: list
      .filter((p) => p.status === 'rejected' || p.status === 'expired')
      .sort((a, b) => timeOf(b.decidedAt ?? b.expiresAt) - timeOf(a.decidedAt ?? a.expiresAt)),
  };
}

function changesListHtml(changes) {
  const rows = (Array.isArray(changes) ? changes : []).map(
    (c) =>
      `<li><code>${esc(c?.path ?? '?')}</code>: ${esc(formatValue(c?.from))} → ${esc(
        formatValue(c?.to)
      )}</li>`
  );
  return rows.length ? `<ul class="watcher-auto-changes">${rows.join('')}</ul>` : '';
}

function predictionText(predicted) {
  if (!predicted || typeof predicted !== 'object') return '';
  const parts = [String(predicted.effect ?? '')].filter(Boolean);
  const saving = Number(predicted.savingUsdPerWeek);
  const cost = Number(predicted.costUsdPerWeek);
  if (Number.isFinite(saving) && saving > 0) parts.push(`saves about ${money(saving)} a week`);
  if (Number.isFinite(cost) && cost > 0) parts.push(`costs about ${money(cost)} a week`);
  return parts.join(' · ');
}

function field(label, html) {
  if (!html) return '';
  return `<div class="watcher-auto-field"><span class="watcher-auto-label text-dim">${esc(
    label
  )}</span><div>${html}</div></div>`;
}

function errorHtml(ui, id) {
  const e = ui?.errors?.[id];
  return e ? `<div class="watcher-auto-error" role="alert">${esc(e)}</div>` : '';
}

const approveKey = (p) => `approve:${p.id}:${p.contentHash}`;
const revertKey = (c) => `revert:${c.id}`;

function pendingCardHtml(p, { nowMs, ui }) {
  const busy = ui?.busy === p.id ? ' disabled' : '';
  const armed = isArmed(ui?.armed, approveKey(p), nowMs);
  const note = ui?.rejecting?.[p.id];
  const rejecting = typeof note === 'string';
  const support = (Array.isArray(p.support) ? p.support : [])
    .map((s) => `<code>${esc(s)}</code>`)
    .join(' ');
  const expires = expiresText(p.expiresAt, nowMs);
  const buttons = rejecting
    ? `<input type="text" class="watcher-auto-note" data-autonomy-note="${esc(p.id)}" value="${esc(
        note
      )}" placeholder="Why not? (optional)" aria-label="Rejection note (optional)" maxlength="500"${busy}><button type="button" class="btn btn-sm btn-danger" data-action="autonomy-reject-send" data-proposal-id="${esc(
        p.id
      )}" data-focus-key="reject-send:${esc(p.id)}"${busy}>Reject</button><button type="button" class="btn btn-sm" data-action="autonomy-reject-cancel" data-proposal-id="${esc(
        p.id
      )}" data-focus-key="reject-cancel:${esc(p.id)}"${busy}>Cancel</button>`
    : `<button type="button" class="btn btn-sm${armed ? ' btn-danger' : ' btn-primary'}" data-action="autonomy-approve" data-proposal-id="${esc(
        p.id
      )}" data-content-hash="${esc(p.contentHash)}" data-focus-key="approve:${esc(p.id)}"${busy}>${
        armed ? 'Click again to approve' : 'Approve'
      }</button><button type="button" class="btn btn-sm" data-action="autonomy-reject" data-proposal-id="${esc(
        p.id
      )}" data-focus-key="reject:${esc(p.id)}"${busy}>Reject</button>`;
  return `<li class="watcher-auto-card" data-proposal-card="${esc(p.id)}">
    <div class="watcher-auto-card-head"><strong>${esc(p.title ?? p.id)}</strong><span class="watcher-auto-kind">${esc(
      KIND_WORDS[p.kind] ?? p.kind ?? ''
    )}</span>${expires ? `<span class="watcher-auto-expires text-dim" title="${esc(p.expiresAt)}">${esc(expires)}</span>` : ''}</div>
    ${field('Changes', changesListHtml(p.changes))}
    ${field('Why', esc(p.rationale ?? ''))}
    ${field('Stands on', support)}
    ${field('Expected', esc(predictionText(p.predicted)))}
    ${field('Guard', esc(guardText(p.guard)))}
    ${field('Undo', esc(p.rollback ?? ''))}
    ${errorHtml(ui, p.id)}
    <div class="watcher-auto-actions">${buttons}</div>
  </li>`;
}

function queuedRowHtml(p) {
  return `<li class="watcher-auto-row"><strong>${esc(p.title ?? p.id)}</strong> <span class="watcher-auto-kind">${esc(
    KIND_WORDS[p.kind] ?? p.kind ?? ''
  )}</span>${changesListHtml(p.changes)}</li>`;
}

const CHANGE_STATUS = {
  applied: 'Live',
  reverted: 'Reverted by you',
  'rolled-back': 'Rolled back by its guard',
  'revert-failed': 'Revert failed',
};

function pairsHtml(before, after) {
  const afterOf = new Map((Array.isArray(after) ? after : []).map((a) => [a?.path, a?.value]));
  const rows = (Array.isArray(before) ? before : []).map(
    (b) =>
      `<li><code>${esc(b?.path ?? '?')}</code>: ${esc(formatValue(b?.value))} → ${esc(
        formatValue(afterOf.get(b?.path))
      )}</li>`
  );
  return rows.length ? `<ul class="watcher-auto-changes">${rows.join('')}</ul>` : '';
}

function changeRowHtml(c, { nowMs, ui, titleOf }) {
  const status = CHANGE_STATUS[c.status] ?? String(c.status ?? '');
  const tone = c.status === 'applied' ? 'is-live' : c.status === 'revert-failed' ? 'is-bad' : '';
  const busy = ui?.busy === c.id ? ' disabled' : '';
  const armed = isArmed(ui?.armed, revertKey(c), nowMs);
  const guardLeftH = Math.ceil((timeOf(c.guardUntil) - nowMs) / 3_600_000);
  const when =
    c.status === 'applied'
      ? `applied ${relTime(c.appliedAt, nowMs)}${
          guardLeftH > 0 ? ` · its guard watches ${guardLeftH} h more` : ' · guard window over'
        }`
      : `ended ${relTime(c.endedAt, nowMs)}`;
  // A failed automatic rollback leaves the changed value live and its guard
  // stops watching: only the operator's Revert can put it back.
  const revert =
    c.status === 'applied' || c.status === 'revert-failed'
      ? `<div class="watcher-auto-actions"><button type="button" class="btn btn-sm${
          armed ? ' btn-danger' : ''
        }" data-action="autonomy-revert" data-change-id="${esc(c.id)}" data-focus-key="revert:${esc(
          c.id
        )}"${busy}>${armed ? 'Click again to revert' : 'Revert'}</button></div>`
      : '';
  return `<li class="watcher-auto-row" data-change-row="${esc(c.id)}"><span class="watcher-auto-status ${tone}">${esc(
    status
  )}</span> <strong>${esc(titleOf(c.proposalId) ?? c.proposalId ?? '')}</strong> <span class="text-dim">${esc(
    when
  )}</span>${pairsHtml(c.before, c.after)}${
    c.endReason ? `<div class="watcher-auto-reason">${esc(c.endReason)}</div>` : ''
  }${errorHtml(ui, c.id)}${revert}</li>`;
}

function decidedRowHtml(p, nowMs) {
  const label = p.status === 'expired' ? 'Expired unreviewed' : 'Rejected';
  const at = p.decidedAt ?? p.expiresAt;
  return `<li class="watcher-auto-row"><span class="watcher-auto-status">${esc(label)}</span> <strong>${esc(
    p.title ?? p.id
  )}</strong> <span class="text-dim">${esc(relTime(at, nowMs))}</span>${
    p.note ? `<div class="watcher-auto-reason">${esc(p.note)}</div>` : ''
  }</li>`;
}

export const PROPOSALS_HEAD = {
  title: 'Proposals',
  sub: 'Changes the watcher asks you to make. Nothing applies until you approve it here; every applied change can be reverted, and its guard rolls it back by itself if things get worse.',
};

/**
 * The Proposals section: '' when proposals are off (or the list did not
 * load). `ui`: `{ armed, errors: { [id]: text }, rejecting: { [id]: note }, busy: id }`.
 */
export function proposalsPanelHtml(resp, { nowMs = Date.now(), ui = {} } = {}) {
  if (!resp || typeof resp !== 'object' || resp.enabled !== true) return '';
  const { pending, queued, decided } = orderProposals(resp.proposals);
  const titles = new Map(
    (Array.isArray(resp.proposals) ? resp.proposals : []).map((p) => [p?.id, p?.title])
  );
  const titleOf = (id) => titles.get(id) ?? null;
  const changes = (Array.isArray(resp.changes) ? resp.changes : [])
    .filter((c) => c && typeof c === 'object')
    .sort((a, b) => timeOf(b.endedAt ?? b.appliedAt) - timeOf(a.endedAt ?? a.appliedAt));
  const history = [
    ...changes.map((c) => ({
      at: timeOf(c.endedAt ?? c.appliedAt),
      html: changeRowHtml(c, { nowMs, ui, titleOf }),
    })),
    ...decided.map((p) => ({
      at: timeOf(p.decidedAt ?? p.expiresAt),
      html: decidedRowHtml(p, nowMs),
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .map((h) => h.html);
  const max = Number(resp.maxPending);
  const pendingHtml = pending.length
    ? `<ul class="watcher-auto-list">${pending.map((p) => pendingCardHtml(p, { nowMs, ui })).join('')}</ul>`
    : '<p class="watcher-auto-empty text-dim">Nothing to review.</p>';
  const queuedHtml = queued.length
    ? `<div class="watcher-auto-sub">Waiting for a review slot (${pending.length}${
        Number.isFinite(max) ? ` of ${max}` : ''
      } pending)</div><ul class="watcher-auto-list">${queued.map(queuedRowHtml).join('')}</ul>`
    : '';
  const historyHtml = history.length
    ? `<div class="watcher-auto-sub">History</div><ul class="watcher-auto-list">${history.join('')}</ul>`
    : '';
  return `<div class="watcher-card-head"><div class="watcher-log-title">${esc(
    PROPOSALS_HEAD.title
  )}</div><div class="watcher-card-sub">${esc(PROPOSALS_HEAD.sub)}</div></div>${pendingHtml}${queuedHtml}${historyHtml}`;
}

/**
 * Replace the panel's markup? Only when it changed, and never while the
 * operator types a rejection note (`typing`), unless the page itself just
 * changed what the panel shows (`force`).
 */
export function shouldRedrawProposals(prevHtml, nextHtml, { typing = false, force = false } = {}) {
  if (force) return prevHtml !== nextHtml || prevHtml == null;
  if (typing) return false;
  return prevHtml !== nextHtml;
}

/**
 * "Sent to you" — pure helpers for the Work → Sent to you tab
 * (docs/plans/why-everywhere-plan.md, phase 1 row 10): the messages agents
 * chose to send on their own (`send_proactive_message`), delivered or not.
 * String in, string out; `sent.js` owns the DOM and the network.
 *
 * Data: `GET /api/proactive` → `{ messages, hasMore, nextBefore }`, each
 * message `{ botId, botName, avatarUrl, sentAt, recipient, toOperator,
 * message, status, delivered, reason?, why }` (`src/web/routes/proactive.ts`).
 * Cards reuse the dispatch card styles; the fold is the shared `whyPanel`.
 */
import { avatar, badge, cx, emptyState, esc } from '../ui/index.js';
import { ago } from './agent-home-helpers.js';
import { whyPanel } from './why-helpers.js';

export const SENT_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'not-sent', label: 'Not sent' },
];

const enc = encodeURIComponent;

export function filterSent(list, filter = 'all') {
  const items = Array.isArray(list) ? list : [];
  if (filter === 'delivered') return items.filter((m) => m.delivered);
  if (filter === 'not-sent') return items.filter((m) => !m.delivered);
  return items;
}

export function sentCounts(list) {
  const items = Array.isArray(list) ? list : [];
  const delivered = items.filter((m) => m.delivered).length;
  return { all: items.length, delivered, 'not-sent': items.length - delivered };
}

/** "to you" for the operator, otherwise the chat or user id the agent named. */
export function recipientLabel(m) {
  return m?.toOperator ? 'to you' : `to ${m?.recipient || 'unknown'}`;
}

const STATUS_BADGE = {
  delivered: ['delivered', 'ok'],
  refused: ['not sent · throttled', 'warn'],
  failed: ['not sent · failed', 'danger'],
};

export function sentCard(m, { avatarSrc = (u) => u, nowMs = Date.now() } = {}) {
  const botId = m.botId ?? '';
  const who = `<a class="curio-who" href="#/agents/${esc(enc(botId))}">${avatar({
    seed: botId,
    name: m.botName ?? botId,
    src: m.avatarUrl ? avatarSrc(m.avatarUrl) : undefined,
    size: 28,
  })}<span>${esc(m.botName ?? botId)}</span></a>`;
  const [label, tone] = STATUS_BADGE[m.status] ?? STATUS_BADGE.failed;
  const meta = [
    `<span class="text-sm">${esc(recipientLabel(m))}</span>`,
    badge(label, tone),
    `<span class="text-dim text-sm">${esc(ago(m.sentAt, nowMs))}</span>`,
  ].join(' ');
  const reason = !m.delivered && m.reason ? `<div class="sent-reason">${esc(m.reason)}</div>` : '';
  return `<article class="${cx('curio-dispatch', !m.delivered && 'curio-dispatch-held')}">
    <div class="curio-dispatch-head">${who}<span class="curio-dispatch-meta">${meta}</span></div>
    <div class="sent-message">${esc(m.message)}</div>
    ${reason}
    ${whyPanel(m.why, { nowMs, botId })}
  </article>`;
}

export function sentList(list, opts = {}) {
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) {
    return emptyState({
      icon: '✉',
      title: opts.emptyTitle ?? 'No messages yet',
      hint:
        opts.emptyHint ??
        'When an agent decides to message you (or someone else) on its own, it shows up here, delivered or not.',
    });
  }
  return `<div class="curio-dispatches">${items.map((m) => sentCard(m, opts)).join('')}</div>`;
}

const keyOf = (m) => `${m.botId}\u0000${m.sentAt}`;

/** Shown messages followed by an older page, minus any already shown. */
export function mergeSentPage(shown, page) {
  const seen = new Set(shown.map(keyOf));
  return [...shown, ...page.filter((m) => !seen.has(keyOf(m)))];
}

/**
 * Work → Conversations: pure helpers (UX overhaul, docs/plans/ux-overhaul-plan.md).
 * Filtering by type / inbox status / title, bot-name lookup, the Delete All
 * dialog copy and the filter bar markup. `conversations.js` owns DOM + network.
 */
import { esc } from '../ui/index.js';

export const CONV_TYPES = [
  { id: '', label: 'All types' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'general', label: 'Chat' },
  { id: 'productions', label: 'Productions' },
];

export const CONV_STATUSES = [
  { id: '', label: 'Any status' },
  { id: 'pending', label: 'Pending' },
  { id: 'closed', label: 'Closed' },
];

const TYPE_LABEL = { general: 'Chat', inbox: 'Inbox', productions: 'Productions' };

export function convTypeLabel(type) {
  return TYPE_LABEL[type] ?? String(type ?? '');
}

/** 'pending' | 'closed' for inbox conversations; '' for chats (no status). */
export function convStatus(c) {
  if (c?.type !== 'inbox') return '';
  return c.inboxStatus === 'pending' ? 'pending' : 'closed';
}

export function filterConversations(list, { type = '', status = '', q = '' } = {}) {
  const needle = String(q ?? '')
    .trim()
    .toLowerCase();
  return (Array.isArray(list) ? list : []).filter((c) => {
    if (type && c?.type !== type) return false;
    if (status && convStatus(c) !== status) return false;
    if (needle && !String(c?.title ?? '').toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** Bot name from the `GET /api/conversations` index (`[{ botId, name }]`). */
export function botDisplayName(bots, botId) {
  const hit = (Array.isArray(bots) ? bots : []).find((b) => b?.botId === botId);
  return hit?.name || botId;
}

/** Options for `confirmDialog` when deleting many conversations at once. */
export function deleteAllDialog(count, botName = '') {
  const n = Number(count) || 0;
  const noun = n === 1 ? 'conversation' : 'conversations';
  const scope = botName ? ` for ${botName}` : ' across all agents';
  return {
    title: 'Delete conversations',
    message: `Delete ${n} ${noun}${scope}? This cannot be undone.`,
    confirmLabel: `Delete ${n} ${noun}`,
    tone: 'danger',
  };
}

function options(list, current) {
  return list
    .map(
      (o) =>
        `<option value="${esc(o.id)}"${o.id === current ? ' selected' : ''}>${esc(o.label)}</option>`
    )
    .join('');
}

/** Filter bar for one bot's conversation list. */
export function conversationFilters({ type = '', status = '', q = '' } = {}) {
  return `<div class="conv-filters">
    <input type="search" id="conv-filter-q" class="conv-filter-q" data-page-filter placeholder="Filter by title…" value="${esc(
      q
    )}" aria-label="Filter conversations">
    <select id="conv-filter-type" class="cron-filter" aria-label="Type">${options(CONV_TYPES, type)}</select>
    <select id="conv-filter-status" class="cron-filter" aria-label="Status">${options(
      CONV_STATUSES,
      status
    )}</select>
  </div>`;
}

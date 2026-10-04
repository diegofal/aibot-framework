/**
 * Work → Sessions: pure helpers (UX overhaul, docs/plans/ux-overhaul-plan.md).
 * `GET /api/sessions` → array (or `{ error }`); `GET /api/sessions/:key/transcript?limit&offset`
 * → `{ total, offset, limit, messages }`, oldest first.
 */

export const TRANSCRIPT_PAGE = 200;

/** `{ error, sessions }` — never throws on an error object or garbage. */
export function normalizeSessionList(res) {
  if (!Array.isArray(res)) {
    return { error: res?.error || 'The server did not return a session list.', sessions: [] };
  }
  const t = (s) => Date.parse(s?.lastActivityAt) || 0;
  return { error: null, sessions: [...res].sort((a, b) => t(b) - t(a)) };
}

/** e.g. "bot:default:private:123456" or "bot:default:group:-5234162254:topic:123". */
export function parseSessionKey(key) {
  const parts = String(key ?? '').split(':');
  const botId = parts[1] || '?';
  const chatType = parts[2] || '?';
  const chatId = parts[3] || '?';
  let label = chatType === 'private' ? `DM ${chatId}` : `${chatType} ${chatId}`;
  label += ` (${botId})`;
  if (parts[4] === 'topic') label += ` #${parts[5]}`;
  return { botId, chatType, chatId, label };
}

/** Offset of the newest page. */
export function latestWindow(total, page = TRANSCRIPT_PAGE) {
  return Math.max(0, (Number(total) || 0) - page);
}

/** The page right before `start`, or null when the transcript is fully loaded. */
export function earlierWindow(start, page = TRANSCRIPT_PAGE) {
  if (!start || start <= 0) return null;
  const offset = Math.max(0, start - page);
  return { offset, limit: start - offset };
}

export function transcriptText(msg) {
  if (typeof msg?.content === 'string') return msg.content;
  if (Array.isArray(msg?.content)) return msg.content.map((c) => c?.text || '[media]').join('\n');
  return '';
}

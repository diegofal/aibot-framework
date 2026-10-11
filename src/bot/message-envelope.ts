/**
 * Inbound message envelope: `[Sun 2026-10-11 12:50 · +7d]` in front of every
 * user message, stored with it in the transcript. Without it the model sees a
 * history of bare strings and cannot tell a reply from a minute ago from one
 * after a week of silence, so it "continues" conversations that went cold.
 *
 * Times are process-local (process.env.TZ, set from config.datetime.timezone),
 * the same clock as the "Today is …" line of the system prompt.
 */
import { localDateStr, localTimeStr } from '../date-utils';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Compact gap: +30s, +5m, +47h, +3d. */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `+${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `+${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `+${hours}h`;
  return `+${Math.floor(hours / 24)}d`;
}

/** `Sun 2026-10-11 12:50` in process-local time. */
export function formatLocalStamp(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${localDateStr(date)} ${localTimeStr(date)}`;
}

/**
 * `[Sun 2026-10-11 12:50]`, plus ` · +7d` when the previous message of the chat
 * is known. `previousAt` is an ISO timestamp (SessionMeta.lastActivityAt).
 */
export function formatEnvelope(now: Date, previousAt?: string): string {
  let envelope = formatLocalStamp(now);
  const previousMs = previousAt ? Date.parse(previousAt) : Number.NaN;
  if (Number.isFinite(previousMs)) {
    envelope += ` · ${formatElapsed(now.getTime() - previousMs)}`;
  }
  return `[${envelope}]`;
}

const ENVELOPE_RE =
  /^\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: · \+\d+[smhd])?\] ?/;

/** Prefix `text` with an envelope. */
export function withEnvelope(text: string, now: Date, previousAt?: string): string {
  return `${formatEnvelope(now, previousAt)} ${text}`;
}

/**
 * Drop a leading envelope: from a stored message shown in a UI, and from a
 * reply in which the model copied the header (the person must never see it).
 */
export function stripEnvelope(text: string): string {
  return text.replace(ENVELOPE_RE, '');
}

/** System-prompt note so the model reads the envelope instead of echoing it. */
export const ENVELOPE_PROMPT_NOTE =
  'Each user message starts with a header like [Sun 2026-10-11 12:50 · +7d]: when it was sent, ' +
  'and how long after the previous message in this chat. Use it to judge how fresh the conversation is ' +
  '— after a long gap, do not carry on as if the last exchange just happened. Never write this header yourself.';

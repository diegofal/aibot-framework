/**
 * Where one conversation ends and the next begins.
 *
 * `endConversation` is the single way a chat's session ends (reset policy,
 * /new, /reset, /start, /clear): it keeps a short record of how it left off,
 * clears the transcript and flushes the unseen part to memory, dated by when
 * it was said. The next conversation sees that record as background
 * (`renderPreviousSession`) instead of as a live thread to continue.
 */
import type { Logger } from '../logger';
import {
  type EndedSession,
  type SessionEndReason,
  type SessionManager,
  unflushedMessageCount,
} from '../session';
import type { MemoryFlusher } from './memory-flush';
import { formatLocalStamp, stripEnvelope } from './message-envelope';

/** The previous-conversation block is shown while the new one is shorter than this. */
export const PREVIOUS_SESSION_MAX_HISTORY = 10;

export function shouldShowPreviousSession(historyLength: number): boolean {
  return historyLength < PREVIOUS_SESSION_MAX_HISTORY;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/** "just now", "40 minutes ago", "5 hours ago", "8 days ago". */
export function humanizeAgo(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return plural(min, 'minute');
  const hours = Math.floor(min / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

/** System-prompt block about the conversation before this one. */
export function renderPreviousSession(ended: EndedSession, now: Date = new Date()): string {
  const lastMs = Date.parse(ended.lastActivityAt);
  const when = Number.isFinite(lastMs)
    ? `${humanizeAgo(now.getTime() - lastMs)} (${formatLocalStamp(new Date(lastMs))})`
    : 'some time ago';
  const lines = [
    '## Previous conversation',
    `This is a new conversation. Your previous one in this chat ended; its last message was ${when}.`,
  ];
  if (ended.summary) lines.push('', `Summary: ${ended.summary}`);
  if (ended.tail.length > 0) {
    lines.push('', 'How it left off (background only, may be stale):');
    for (const m of ended.tail) {
      lines.push(`- ${m.role === 'user' ? 'them' : 'you'}: ${stripEnvelope(m.content)}`);
    }
  }
  lines.push(
    '',
    'Do not pick up pending topics from it on your own. Greet according to the time that passed, ' +
      'and refer back only if they do or it clearly matters now. Facts from it are as old as that conversation, not from today.'
  );
  return lines.join('\n');
}

/**
 * Stands in for the user's text when they start a conversation explicitly
 * (/new, /reset, /start), so the bot opens it in its own voice.
 */
export function buildSessionStartPrompt(command: string): string {
  return (
    `[New conversation] The person just started a new conversation with ${command}. ` +
    'Greet them briefly in your own voice (1-3 sentences) and invite them to say what they need. ' +
    'Do not pick up pending topics from earlier conversations on your own; if some time passed, a natural nod to it is fine. ' +
    'Do not mention commands, sessions or this note.'
  );
}

export interface EndConversationDeps {
  sessionManager: SessionManager;
  memoryFlusher: Pick<MemoryFlusher, 'flushSessionToMemory'>;
  soulEnabled: boolean;
  logger: Logger;
}

export interface EndConversationInput {
  botId: string;
  serializedKey: string;
  reason: SessionEndReason;
  /** Whose memory the flushed facts belong to. */
  memoryUserId?: string;
  /** Default true; `/clear --no-flush` passes false. */
  flush?: boolean;
}

/** End the chat's conversation. Null when there was none. Never throws on a failed flush. */
export async function endConversation(
  deps: EndConversationDeps,
  input: EndConversationInput
): Promise<EndedSession | null> {
  const { sessionManager } = deps;
  // Older turns were already extracted by the proactive flush.
  const unflushed = unflushedMessageCount(sessionManager.getSessionMeta(input.serializedKey));
  const result = sessionManager.endSession(input.serializedKey, input.reason);
  if (!result) return null;

  if (input.flush !== false && deps.soulEnabled && unflushed > 0) {
    try {
      await deps.memoryFlusher.flushSessionToMemory(
        result.history.slice(-unflushed),
        input.botId,
        input.memoryUserId,
        { observedAt: result.ended.lastActivityAt }
      );
    } catch (err) {
      deps.logger.warn(
        { err, key: input.serializedKey },
        'Memory flush on conversation end failed'
      );
    }
  }

  deps.logger.info(
    { key: input.serializedKey, reason: input.reason, messages: result.ended.messageCount },
    'Conversation ended'
  );
  return result.ended;
}

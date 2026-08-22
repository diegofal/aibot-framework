import { join } from 'node:path';
import type { Conversation } from '../../conversations/service';
import type { AskDetail } from '../types';
import { readJsonlSafe, toMs } from '../util';

interface MessageLike {
  role?: string;
  content?: string;
  createdAt?: string;
}

/** Inbox statuses that mean "closed without the human ever answering". */
const CLOSED_UNANSWERED = new Set(['dismissed', 'timed_out', 'closed']);

function conversationsOf(baseDir: string, botId: string): Conversation[] {
  return readJsonlSafe<Conversation>(join(baseDir, botId, 'conversations.jsonl'));
}

function messagesOf(baseDir: string, botId: string, conversationId: string): MessageLike[] {
  return readJsonlSafe<MessageLike>(join(baseDir, botId, 'messages', `${conversationId}.jsonl`));
}

/**
 * Every `ask_human` question the bot raised, as an inbox conversation.
 * `questionChars` is the length of the first bot message (the question
 * itself); `answeredAt` is the first human reply, or null.
 */
export function readInboxAsks(baseDir: string, botId: string): AskDetail[] {
  const out: AskDetail[] = [];
  for (const c of conversationsOf(baseDir, botId)) {
    if (c.type !== 'inbox') continue;
    const messages = messagesOf(baseDir, botId, c.id);
    const question = messages.find((m) => m.role === 'bot');
    const answer = messages.find((m) => m.role === 'human');
    out.push({
      id: c.id,
      title: c.title ?? '',
      createdAt: c.createdAt,
      inboxStatus: c.inboxStatus ?? null,
      questionChars: question?.content?.length ?? 0,
      answeredAt: answer?.createdAt ?? null,
    });
  }
  return out;
}

export interface AskSummary {
  asksSent: number;
  asksAnswered: number;
  asksPending: number;
  asksClosedUnanswered: number;
}

export function summariseAsks(asks: AskDetail[], sinceMs: number): AskSummary {
  const s: AskSummary = { asksSent: 0, asksAnswered: 0, asksPending: 0, asksClosedUnanswered: 0 };
  for (const a of asks) {
    const t = toMs(a.createdAt);
    if (t !== null && t < sinceMs) continue;
    s.asksSent++;
    const answered = a.answeredAt !== null || a.inboxStatus === 'answered';
    if (answered) s.asksAnswered++;
    else if (a.inboxStatus === 'pending') s.asksPending++;
    else if (a.inboxStatus && CLOSED_UNANSWERED.has(a.inboxStatus)) s.asksClosedUnanswered++;
  }
  return s;
}

/**
 * Most recent human-authored message in any dashboard conversation of the bot.
 * Conversations are visited newest-first by `updatedAt`; since a message can
 * never be newer than its conversation's `updatedAt`, the scan stops as soon
 * as the next conversation cannot beat the best timestamp found so far.
 */
export function lastHumanMessageAt(baseDir: string, botId: string): number | null {
  const convos = conversationsOf(baseDir, botId).sort(
    (a, b) => (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0)
  );
  let best: number | null = null;
  for (const c of convos) {
    const updated = toMs(c.updatedAt) ?? 0;
    if (best !== null && updated < best) break;
    for (const m of messagesOf(baseDir, botId, c.id)) {
      if (m.role !== 'human') continue;
      const t = toMs(m.createdAt);
      if (t !== null && (best === null || t > best)) best = t;
    }
  }
  return best;
}

/**
 * Relay text formatting — pure functions. The header and the reply footer are
 * stamped by the system, never written by the model, so the recipient always
 * knows who is speaking and how to answer.
 */
import { createHash } from 'node:crypto';
import type { RelayRecord } from './types';

export type RelayLocale = 'es' | 'en';
export const DEFAULT_RELAY_LOCALE: RelayLocale = 'es';

/** How much of the original message an answer quotes. */
export const ANSWER_QUOTE_CHARS = 80;

const STRINGS: Record<
  RelayLocale,
  {
    header: (from: string, bot: string) => string;
    replyFooter: (from: string) => string;
    replyPlaceholder: (from: string) => string;
    answerHeader: (answerer: string, bot: string, quote: string) => string;
    ack: (name: string) => string;
    answerQueued: (name: string) => string;
    answerFailed: (name: string) => string;
  }
> = {
  es: {
    header: (from, bot) => `📨 De ${from} (vía ${bot}):`,
    replyFooter: (from) => `↩️ Respondé a este mensaje y se lo paso a ${from}.`,
    replyPlaceholder: (from) => `Respuesta para ${from}`,
    answerHeader: (answerer, bot, quote) => `↩️ Respuesta de ${answerer} (vía ${bot}) a: «${quote}»`,
    ack: (name) => `✅ Se lo pasé a ${name}.`,
    answerQueued: (name) =>
      `⚠️ No pude avisarle a ${name}: tu respuesta quedó guardada y la verá cuando vuelva a escribir.`,
    answerFailed: (name) => `⚠️ No pude pasarle tu respuesta a ${name}. No le llegó nada.`,
  },
  en: {
    header: (from, bot) => `📨 From ${from} (via ${bot}):`,
    replyFooter: (from) => `↩️ Reply to this message and I'll pass it to ${from}.`,
    replyPlaceholder: (from) => `Reply to ${from}`,
    answerHeader: (answerer, bot, quote) => `↩️ Answer from ${answerer} (via ${bot}) to: «${quote}»`,
    ack: (name) => `✅ Passed to ${name}.`,
    answerQueued: (name) =>
      `⚠️ I couldn't notify ${name}: your answer is stored and they will see it when they write again.`,
    answerFailed: (name) => `⚠️ I couldn't pass your answer to ${name}. Nothing reached them.`,
  },
};

/**
 * The text the recipient receives. From the bot itself (`from: null`) it is
 * the bare text: there is nobody to name and no return path.
 */
export function formatRelayForRecipient(
  record: Pick<RelayRecord, 'from' | 'text' | 'expectsReply'>,
  botName: string,
  locale: RelayLocale = DEFAULT_RELAY_LOCALE
): string {
  if (!record.from) return record.text;
  const s = STRINGS[locale];
  const from = record.from.displayName;
  const parts = [s.header(from, botName), record.text];
  if (record.expectsReply) parts.push(s.replyFooter(from));
  return parts.join('\n\n');
}

/** Telegram's limit for `input_field_placeholder`. */
export const REPLY_PLACEHOLDER_MAX_CHARS = 64;

/**
 * Placeholder of the reply box Telegram opens on a relay that expects an
 * answer (`force_reply`): "Respuesta para Ana" / "Reply to Ana", ≤ 64 chars.
 */
export function formatReplyPlaceholder(
  from: string,
  locale: RelayLocale = DEFAULT_RELAY_LOCALE
): string {
  const text = STRINGS[locale].replyPlaceholder(from.trim());
  return text.length > REPLY_PLACEHOLDER_MAX_CHARS
    ? `${text.slice(0, REPLY_PLACEHOLDER_MAX_CHARS - 1)}…`
    : text;
}

/** The text the requester receives when the answer comes back. */
export function formatAnswerForRequester(
  answerText: string,
  answerer: string,
  original: Pick<RelayRecord, 'text'>,
  botName: string,
  locale: RelayLocale = DEFAULT_RELAY_LOCALE
): string {
  const text = original.text.trim();
  const quote = text.length > ANSWER_QUOTE_CHARS ? `${text.slice(0, ANSWER_QUOTE_CHARS)}…` : text;
  return `${STRINGS[locale].answerHeader(answerer, botName, quote)}\n\n${answerText}`;
}

/** Deterministic acknowledgement to the person who answered. */
export function formatAnswerAck(
  requesterName: string,
  locale: RelayLocale = DEFAULT_RELAY_LOCALE
): string {
  return STRINGS[locale].ack(requesterName);
}

/** Honest line to the person who answered when the answer did not reach the requester. */
export function formatAnswerNotDelivered(
  requesterName: string,
  status: 'queued' | 'failed',
  locale: RelayLocale = DEFAULT_RELAY_LOCALE
): string {
  const s = STRINGS[locale];
  return status === 'queued' ? s.answerQueued(requesterName) : s.answerFailed(requesterName);
}

/**
 * Identity of "the same message to the same person": bot, sender address (or
 * `'bot'`), recipient (contact id or address) and the text normalized for case
 * and whitespace. 16 hex chars of sha256.
 */
export function relayDedupeKey(
  botId: string,
  fromAddress: string,
  toContactOrAddress: string,
  text: string
): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256')
    .update([botId, fromAddress, toContactOrAddress, normalized].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

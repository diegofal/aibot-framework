/**
 * Conversation-prompt sections built from relay records, for the person the
 * bot is talking with: what is waiting on their answer, and what they asked
 * the bot to pass on. Delivery facts in a reply must come from here.
 */
import type { RelayStore } from './store';
import type { RelayParty, RelayRecord } from './types';

export const RELAY_PROMPT_MAX_ITEMS = 5;
export const RELAY_PROMPT_TEXT_CHARS = 120;
export const RELAY_PROMPT_SENT_DAYS = 7;

const clip = (text: string): string => {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > RELAY_PROMPT_TEXT_CHARS ? `${t.slice(0, RELAY_PROMPT_TEXT_CHARS)}…` : t;
};

function age(fromMs: number, nowMs: number): string {
  const min = Math.floor((nowMs - fromMs) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusText(store: RelayStore, r: RelayRecord): string {
  switch (r.status) {
    case 'answered': {
      const answer = r.answerRelayId ? store.get(r.botId, r.answerRelayId) : undefined;
      return answer ? `answered: "${clip(answer.text)}"` : 'answered';
    }
    case 'delivered':
      return r.expectsReply ? 'delivered, no answer yet' : 'delivered';
    case 'queued':
      return 'NOT delivered (stored, nobody notified)';
    default:
      return 'FAILED, nothing was sent';
  }
}

/** Both sections for `speaker`, or '' when there is nothing to say. */
export function renderRelaySections(
  store: RelayStore,
  botId: string,
  speaker: Pick<RelayParty, 'channelKind' | 'address'>,
  nowMs: number = Date.now()
): string {
  const waiting = store
    .openFor(botId, speaker.channelKind, speaker.address)
    .slice(0, RELAY_PROMPT_MAX_ITEMS);
  const sent = store
    .sentBy(
      botId,
      speaker.channelKind,
      speaker.address,
      nowMs - RELAY_PROMPT_SENT_DAYS * 86_400_000
    )
    .slice(0, RELAY_PROMPT_MAX_ITEMS);
  if (waiting.length === 0 && sent.length === 0) return '';

  const parts: string[] = [];
  if (waiting.length > 0) {
    parts.push(
      [
        "## Messages waiting for this person's answer",
        "Passed to them on someone's behalf. If their message answers one, call send_message with replyTo=<id> and their answer as the message.",
        ...waiting.map(
          (r) =>
            `- ${r.id} · from ${r.from?.displayName ?? 'you'} · ${age(r.createdAt, nowMs)}: "${clip(r.text)}"`
        ),
      ].join('\n')
    );
  }
  if (sent.length > 0) {
    parts.push(
      [
        `## Messages this person asked you to pass on (last ${RELAY_PROMPT_SENT_DAYS} days)`,
        ...sent.map(
          (r) =>
            `- ${r.id} → ${r.to.displayName} · ${age(r.createdAt, nowMs)} · ${statusText(store, r)}`
        ),
      ].join('\n')
    );
  }
  parts.push(
    'Delivery facts come only from these records: never say a message was delivered or answered unless it is listed here as such.'
  );
  return parts.join('\n\n');
}

/** Channels where the platform vouches for the sender's id (the bot cannot be lied to about it). */
const VERIFIED_CHANNELS: ReadonlySet<string> = new Set(['telegram', 'whatsapp', 'discord']);

const SPEAKER_NAME_CHARS = 60;

/** A display name as one plain line: no newlines, bounded. */
const speakerName = (name: string): string => {
  const flat = name.replace(/\s+/g, ' ').trim() || 'Unknown';
  return flat.length > SPEAKER_NAME_CHARS ? `${flat.slice(0, SPEAKER_NAME_CHARS)}…` : flat;
};

/**
 * "## Who you are talking with" for the conversation prompt, built from the
 * same speaker party relays use (`RelayService.speaker`). Without it a private
 * chat never says who is speaking, and the model guesses from context — e.g.
 * greets the operator as the person whose relayed message came last.
 */
export function renderSpeakerSection(
  speaker: Pick<RelayParty, 'displayName' | 'channelKind' | 'isOperator'>,
  opts: { isGroup: boolean }
): string {
  const name = speakerName(speaker.displayName);
  const verified = VERIFIED_CHANNELS.has(speaker.channelKind)
    ? 'identity verified by the channel'
    : 'identity not verified';
  const who = speaker.isOperator
    ? `${name} — your operator (${speaker.channelKind}, ${verified}).`
    : `${name} — not your operator (${speaker.channelKind} user, ${verified}).`;
  const relayed =
    'Messages from other people never arrive as user messages here; they appear only as relayed messages (📨 …) that you passed on.';
  const lines = ['## Who you are talking with'];
  if (opts.isGroup) {
    lines.push(
      `This is a group chat: each user message is prefixed with its sender's name ([Name]:). The latest message is from ${who}`,
      `${relayed} When you answer here you are talking to the people in this group, not to whoever a relayed message came from.`
    );
  } else {
    lines.push(
      `${who} Every user message in this chat is from ${name}.`,
      `${relayed} When you answer here you are talking to ${name}, not to whoever a relayed message came from.`
    );
  }
  return lines.join('\n');
}

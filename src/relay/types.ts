/**
 * Relay — a durable record of a message one person asked a bot to pass to
 * another, plus the system-owned obligation to route the answer back.
 * Design: docs/plans/relay-plan.md.
 */
import type { ChannelKind } from '../channel/types';

/**
 * What happened to one delivery:
 * - `delivered`: a person was reached (Telegram/WhatsApp accepted it, or a live web connection exists);
 * - `queued`: stored where the person will see it later, nobody was notified;
 * - `failed`: nothing reached anyone.
 */
export type DeliveryStatus = 'delivered' | 'queued' | 'failed';

/** One route tried by the delivery resolver. */
export interface DeliveryAttempt {
  channel: ChannelKind;
  /** Bot whose Telegram instance carried (or tried to carry) the message. */
  viaBotId?: string;
  status: DeliveryStatus;
  error?: string;
}

/** Result of `deliverToContact`: the final status plus every route tried, in order. */
export interface DeliveryOutcome {
  status: DeliveryStatus;
  /** Channel that produced the final status (absent when nothing was attempted). */
  channel?: ChannelKind;
  /** The contact address that was reached (or stored to, when queued). */
  address?: string;
  viaBotId?: string;
  /** Telegram message id of the delivered message (what a reply-to points at). */
  telegramMessageId?: number;
  /** Why it is not `delivered` (or the last error seen). */
  error?: string;
  attempts: DeliveryAttempt[];
}

/** One side of a relay: who said it, or who it is for. */
export interface RelayParty {
  /** UserDirectory contact id, when the party is a known contact. */
  contactId?: string;
  displayName: string;
  channelKind: ChannelKind;
  /** Channel address (Telegram chat id, phone, web session id). */
  address: string;
  isOperator?: boolean;
}

/** Relay lifecycle: the delivery status, then `answered` once the reply went back. */
export type RelayStatus = 'delivered' | 'queued' | 'failed' | 'answered';

/** A relay record as stored in `<data>/relays/<botId>.jsonl` (last line per id wins). */
export interface RelayRecord {
  /** `r-` + 8 hex. */
  id: string;
  botId: string;
  createdAt: number;
  updatedAt: number;
  /** Who asked for it; `null` = the bot itself (agent loop): no header, no return path. */
  from: RelayParty | null;
  to: RelayParty;
  /** The message as the requester worded it (without the header). */
  text: string;
  /** The recipient was asked to answer; the answer is routed back to `from`. */
  expectsReply: boolean;
  /** Set on an answer relay: the relay it answers. */
  replyToRelayId?: string;
  status: RelayStatus;
  delivery: DeliveryOutcome;
  answeredAt?: number;
  /** The relay that carried the answer back. */
  answerRelayId?: string;
  /** `relayDedupeKey(...)`: same sender, recipient and text. */
  dedupeKey: string;
}

/** Input to `RelayStore.create`: everything but the store-assigned fields. */
export type NewRelayRecord = Omit<RelayRecord, 'id' | 'createdAt' | 'updatedAt'>;

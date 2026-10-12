/**
 * RelayService — the one path every relay takes, whoever triggers it
 * (`send_message`, a Telegram reply-to in the gate): who is speaking, dedupe,
 * the record, delivery, the answer bookkeeping and the session transcripts.
 * Never throws for data problems; delivery outcomes are reported, not raised.
 */
import type { ContactEntry, UserDirectory } from '../bot/user-directory';
import type { ChannelKind } from '../channel/types';
import type { Logger } from '../logger';
import { type ResolvedRelayConfig, resolveRelayConfig } from './config';
import { type DeliveryDeps, deliverToContact } from './delivery';
import {
  formatAnswerAck,
  formatAnswerForRequester,
  formatAnswerNotDelivered,
  formatRelayForRecipient,
  relayDedupeKey,
} from './format';
import { renderRelaySections } from './prompt';
import { type RelayStore, isRelayOpen } from './store';
import type { DeliveryOutcome, RelayParty, RelayRecord } from './types';

/** Identical text to the same recipient within this window is not sent again. */
export const RELAY_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** The slice of `Config` the relay needs (read live, so config edits apply). */
export interface RelayServiceConfigView {
  operator?: { name?: string; telegramChatId?: number; email?: string };
  bots: Array<{ id: string; name: string; relay?: Partial<ResolvedRelayConfig> }>;
}

export interface RelayServiceDeps {
  store: RelayStore;
  directory: UserDirectory;
  delivery: DeliveryDeps;
  config: () => RelayServiceConfigView;
  /** Append an assistant line to `party`'s private session with `botId`. */
  appendToSession?: (botId: string, party: RelayParty, text: string) => void;
  logger: Logger;
}

export interface RelaySendInput {
  botId: string;
  /** The person asking (`_requester`); null = the bot itself. */
  from: RelayParty | null;
  to: ContactEntry;
  text: string;
  expectsReply: boolean;
  /** The relay this message answers: formatted as an answer, original marked answered. */
  answering?: RelayRecord;
}

export type RelaySendResult =
  | { duplicate: true; record: RelayRecord }
  | { duplicate: false; record: RelayRecord; outcome: DeliveryOutcome };

export type TelegramReplyRoute =
  | { handled: false }
  | { handled: true; ack: string; relay: RelayRecord; answer: RelaySendResult };

const CHANNEL_ORDER: ChannelKind[] = ['telegram', 'whatsapp', 'web'];

export class RelayService {
  constructor(private deps: RelayServiceDeps) {}

  get store(): RelayStore {
    return this.deps.store;
  }

  settings(botId: string): ResolvedRelayConfig {
    return resolveRelayConfig(this.deps.config().bots.find((b) => b.id === botId));
  }

  botName(botId: string): string {
    return this.deps.config().bots.find((b) => b.id === botId)?.name ?? botId;
  }

  /** Seed the configured operator into `botId`'s directory. Never throws. */
  ensureOperator(botId: string): ContactEntry | undefined {
    const op = this.deps.config().operator;
    if (!op || (op.telegramChatId === undefined && !op.email)) return undefined;
    try {
      return this.deps.directory.ensureOperator(botId, {
        name: op.name || 'Operator',
        telegramChatId: op.telegramChatId,
        email: op.email,
      });
    } catch (err) {
      this.deps.logger.warn({ err, botId }, 'relay: operator seed failed');
      return undefined;
    }
  }

  /** The configured operator's own addresses, independent of the directory. */
  private isOperatorAddress(kind: ChannelKind, address: string): boolean {
    const op = this.deps.config().operator;
    if (!op) return false;
    if (kind === 'telegram' && op.telegramChatId !== undefined) {
      return address === String(op.telegramChatId);
    }
    return !!op.email && address === op.email;
  }

  /** The person speaking on `channelKind`/`address`, as a relay party. */
  speaker(
    botId: string,
    s: { channelKind: ChannelKind; address: string; displayName: string }
  ): RelayParty {
    let contact: ContactEntry | undefined;
    try {
      contact = this.deps.directory.findByChannel(botId, s.channelKind, s.address);
    } catch {
      contact = undefined;
    }
    return {
      ...(contact ? { contactId: contact.id } : {}),
      displayName: contact?.displayName ?? s.displayName,
      channelKind: s.channelKind,
      address: s.address,
      isOperator:
        contact?.metadata?.role === 'operator' || this.isOperatorAddress(s.channelKind, s.address),
    };
  }

  /** A contact as a relay recipient, addressed by its first channel in delivery order. */
  recipientParty(contact: ContactEntry): RelayParty {
    const ordered = [...contact.channels].sort(
      (a, b) =>
        CHANNEL_ORDER.indexOf(a.kind) - CHANNEL_ORDER.indexOf(b.kind) ||
        Number(b.verified) - Number(a.verified)
    );
    const ch = ordered[0];
    return {
      contactId: contact.id,
      displayName: contact.displayName,
      channelKind: ch?.kind ?? 'web',
      address: ch?.address ?? '',
      isOperator:
        contact.metadata?.role === 'operator' ||
        (!!ch && this.isOperatorAddress(ch.kind, ch.address)),
    };
  }

  /** The directory contact behind a party; a bare contact built from it otherwise. */
  contactFor(botId: string, party: RelayParty): ContactEntry {
    let contact: ContactEntry | undefined;
    try {
      contact =
        (party.contactId ? this.deps.directory.getById(botId, party.contactId) : undefined) ??
        this.deps.directory.findByChannel(botId, party.channelKind, party.address);
    } catch {
      contact = undefined;
    }
    return (
      contact ?? {
        id: party.contactId ?? `${party.channelKind}:${party.address}`,
        displayName: party.displayName,
        channels: [{ kind: party.channelKind, address: party.address, verified: true }],
        firstSeen: 0,
        lastSeen: 0,
      }
    );
  }

  /** Conversation-prompt sections for `speaker` (relay/prompt.ts); '' when none. Never throws. */
  promptSections(botId: string, speaker: Pick<RelayParty, 'channelKind' | 'address'>): string {
    try {
      return renderRelaySections(this.deps.store, botId, speaker);
    } catch (err) {
      this.deps.logger.warn({ err, botId }, 'relay: prompt sections failed');
      return '';
    }
  }

  /** Dedupe → record → deliver → update → answer bookkeeping → session transcript. */
  async send(input: RelaySendInput): Promise<RelaySendResult> {
    const { botId, from, to, text, expectsReply, answering } = input;
    const { store, logger } = this.deps;
    // An answer is keyed by the relay it answers: "sí" to two questions is two answers.
    const target = answering ? `${to.id}#${answering.id}` : to.id;
    const dedupeKey = relayDedupeKey(botId, from?.address ?? 'bot', target, text);
    const duplicate = store.findDuplicate(botId, dedupeKey, RELAY_DEDUPE_WINDOW_MS);
    if (duplicate) return { duplicate: true, record: duplicate };

    const toParty = this.recipientParty(to);
    const created = store.create({
      botId,
      from,
      to: toParty,
      text,
      expectsReply,
      ...(answering ? { replyToRelayId: answering.id } : {}),
      status: 'queued',
      delivery: { status: 'queued', error: 'delivering', attempts: [] },
      dedupeKey,
    });

    const { locale } = this.settings(botId);
    const botName = this.botName(botId);
    const delivered = answering
      ? formatAnswerForRequester(text, from?.displayName ?? botName, answering, botName, locale)
      : formatRelayForRecipient({ from, text, expectsReply }, botName, locale);

    const outcome = await deliverToContact(botId, to, delivered, this.deps.delivery);
    const reached: RelayParty = {
      ...toParty,
      ...(outcome.channel ? { channelKind: outcome.channel } : {}),
      ...(outcome.address ? { address: outcome.address } : {}),
    };
    const record =
      store.update(botId, created.id, { status: outcome.status, delivery: outcome, to: reached }) ??
      created;

    if (answering && outcome.status !== 'failed') {
      store.update(answering.botId, answering.id, {
        status: 'answered',
        answeredAt: Date.now(),
        answerRelayId: record.id,
      });
    }

    // The web route already stored the text in that session.
    if (outcome.status !== 'failed' && outcome.channel !== 'web' && this.deps.appendToSession) {
      try {
        this.deps.appendToSession(botId, reached, delivered);
      } catch (err) {
        logger.warn({ err, botId, relayId: record.id }, 'relay: session append failed');
      }
    }

    logger.info(
      {
        botId,
        relayId: record.id,
        status: record.status,
        channel: outcome.channel,
        viaBotId: outcome.viaBotId,
        answering: answering?.id,
      },
      'relay: sent'
    );
    return { duplicate: false, record, outcome };
  }

  /**
   * A Telegram reply-to on a relay message: forward the answer to whoever asked,
   * without an LLM turn. Only open relays from a person are routed.
   */
  async routeTelegramReply(input: {
    viaBotId: string;
    chatAddress: string;
    messageId: number;
    answererAddress: string;
    answererName: string;
    text: string;
  }): Promise<TelegramReplyRoute> {
    const relay = this.deps.store.findByTelegramDelivery(
      input.viaBotId,
      input.chatAddress,
      input.messageId
    );
    if (!relay || !relay.from || !isRelayOpen(relay)) return { handled: false };

    const answerer = this.speaker(relay.botId, {
      channelKind: 'telegram',
      address: input.answererAddress,
      displayName: input.answererName,
    });
    const requester = this.contactFor(relay.botId, relay.from);
    const answer = await this.send({
      botId: relay.botId,
      from: answerer,
      to: requester,
      text: input.text,
      expectsReply: false,
      answering: relay,
    });
    const { locale } = this.settings(relay.botId);
    const status = answer.duplicate ? 'delivered' : answer.record.status;
    const ack =
      status === 'delivered' || status === 'answered'
        ? formatAnswerAck(relay.from.displayName, locale)
        : formatAnswerNotDelivered(relay.from.displayName, status, locale);
    return { handled: true, ack, relay, answer };
  }
}

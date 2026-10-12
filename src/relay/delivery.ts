/**
 * Deterministic delivery resolver: one fixed route order per contact, and a
 * status that never claims more than happened.
 *
 * Telegram (verified channels first; each channel through every instance in
 * order — own bot first, then the fleet) → WhatsApp → web. Web is `delivered`
 * only with a live connection; otherwise the text is stored in the session
 * and the result is `queued` (nobody was notified).
 */
import type { ContactChannel, ContactEntry } from '../bot/user-directory';
import { webSessionUserId } from '../channel/outbound';
import type { ChannelKind } from '../channel/types';
import type { Logger } from '../logger';
import type { DeliveryAttempt, DeliveryOutcome } from './types';

/** A Telegram connection able to send to a chat id. */
export interface TelegramSender {
  botId: string;
  api: {
    sendMessage(
      chatId: number | string,
      text: string,
      opts?: unknown
    ): Promise<{ message_id: number }>;
  };
}

export interface DeliveryDeps {
  /** Live Telegram instances to try for `botId`: its own first, then the fleet's. */
  telegramInstances(botId: string): TelegramSender[];
  sendWhatsApp?(botId: string, address: string, text: string): Promise<void>;
  /** Whether a web client for this address is connected right now. */
  isWebLive?(botId: string, address: string): boolean;
  /** Store the text in the address's web session (see `appendWebSessionMessage`). */
  appendWebSession(botId: string, address: string, text: string): void;
  logger: Logger;
}

export const WEB_QUEUED_NOTE = 'no live connection; stored, not notified';

/**
 * Telegram errors meaning "this bot cannot reach this chat" (blocked, never
 * started, chat unknown to this bot). Another instance may still reach it.
 */
export function isTelegramUnreachable(err: unknown): boolean {
  const e = err as { error_code?: number; description?: string; message?: string } | undefined;
  if (e?.error_code === 403) return true;
  const text = `${e?.description ?? ''} ${e?.message ?? ''}`;
  return /forbidden|bot was blocked|can't initiate|cannot initiate|chat not found|user is deactivated|\b403\b/i.test(
    text
  );
}

const errText = (err: unknown): string =>
  (err as { description?: string })?.description ??
  (err instanceof Error ? err.message : String(err));

const bySendOrder = (a: ContactChannel, b: ContactChannel) =>
  Number(b.verified) - Number(a.verified);

/** Deliver `text` to a contact. Never throws. */
export async function deliverToContact(
  botId: string,
  contact: ContactEntry,
  text: string,
  deps: DeliveryDeps
): Promise<DeliveryOutcome> {
  const attempts: DeliveryAttempt[] = [];
  const channelsOf = (kind: ChannelKind) =>
    contact.channels.filter((c) => c.kind === kind).sort(bySendOrder);
  const done = (outcome: Omit<DeliveryOutcome, 'attempts'>): DeliveryOutcome => ({
    ...outcome,
    attempts,
  });

  // 1. Telegram
  const telegram = channelsOf('telegram');
  if (telegram.length > 0) {
    let instances: TelegramSender[] = [];
    try {
      instances = deps.telegramInstances(botId);
    } catch (err) {
      deps.logger.warn({ err, botId }, 'relay delivery: telegramInstances failed');
    }
    for (const ch of telegram) {
      const chatId = Number(ch.address);
      if (!ch.address || Number.isNaN(chatId)) {
        attempts.push({
          channel: 'telegram',
          status: 'failed',
          error: `"${ch.address}" is not a Telegram chat id`,
        });
        continue;
      }
      if (instances.length === 0) {
        attempts.push({
          channel: 'telegram',
          status: 'failed',
          error: 'no live Telegram instance in the fleet',
        });
        continue;
      }
      for (const inst of instances) {
        try {
          const sent = await inst.api.sendMessage(chatId, text);
          attempts.push({ channel: 'telegram', viaBotId: inst.botId, status: 'delivered' });
          return done({
            status: 'delivered',
            channel: 'telegram',
            address: ch.address,
            viaBotId: inst.botId,
            telegramMessageId: sent?.message_id,
          });
        } catch (err) {
          const error = errText(err);
          attempts.push({ channel: 'telegram', viaBotId: inst.botId, status: 'failed', error });
          deps.logger.info(
            { botId, viaBotId: inst.botId, chatId, error, unreachable: isTelegramUnreachable(err) },
            'relay delivery: telegram attempt failed, trying next route'
          );
        }
      }
    }
  }

  // 2. WhatsApp
  if (deps.sendWhatsApp) {
    for (const ch of channelsOf('whatsapp')) {
      try {
        await deps.sendWhatsApp(botId, ch.address, text);
        attempts.push({ channel: 'whatsapp', status: 'delivered' });
        return done({ status: 'delivered', channel: 'whatsapp', address: ch.address });
      } catch (err) {
        attempts.push({ channel: 'whatsapp', status: 'failed', error: errText(err) });
      }
    }
  }

  // 3. Web — stored in the session; delivered only when someone is connected.
  for (const ch of channelsOf('web')) {
    if (webSessionUserId(ch.address) === undefined) {
      // A non-numeric address maps to the shared anonymous widget session
      // (`private:0`); writing there would show it to every widget visitor.
      attempts.push({
        channel: 'web',
        status: 'failed',
        error: `web address "${ch.address}" is not a widget session id; not stored`,
      });
      continue;
    }
    try {
      deps.appendWebSession(botId, ch.address, text);
    } catch (err) {
      attempts.push({ channel: 'web', status: 'failed', error: errText(err) });
      continue;
    }
    let live = false;
    try {
      live = deps.isWebLive?.(botId, ch.address) ?? false;
    } catch {
      live = false;
    }
    if (live) {
      attempts.push({ channel: 'web', status: 'delivered' });
      return done({ status: 'delivered', channel: 'web', address: ch.address });
    }
    attempts.push({ channel: 'web', status: 'queued', error: WEB_QUEUED_NOTE });
    return done({ status: 'queued', channel: 'web', address: ch.address, error: WEB_QUEUED_NOTE });
  }

  if (attempts.length === 0) {
    const kinds = [...new Set(contact.channels.map((c) => c.kind))].join(', ') || 'none';
    return done({
      status: 'failed',
      error: `No deliverable channel for ${contact.displayName} (channels: ${kinds})`,
    });
  }
  const last = attempts[attempts.length - 1];
  const summary = attempts
    .map((a) => `${a.channel}${a.viaBotId ? ` via ${a.viaBotId}` : ''}: ${a.error ?? a.status}`)
    .join('; ');
  return done({ status: 'failed', channel: last.channel, error: `Not delivered — ${summary}` });
}

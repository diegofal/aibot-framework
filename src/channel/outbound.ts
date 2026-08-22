/**
 * Outbound channel factory — creates Channel instances for proactive messaging
 * without an active request/context.
 *
 * Each channel type has its own delivery mechanism:
 * - telegram: bot.api.sendMessage()
 * - whatsapp: WhatsApp Cloud API REST call
 * - web: append to session transcript (visible on reconnect)
 * - rest: not supported for push (returns null)
 */
import type { Bot } from 'grammy';
import type { ContactChannel } from '../bot/user-directory';
import type { SessionManager } from '../session';
import type { Channel } from './types';
import { type WhatsAppConfig, whatsappChannel } from './whatsapp';

export interface OutboundChannelDeps {
  getTelegramBot: (botId: string) => Bot | undefined;
  /**
   * Any live Telegram instance in the fleet. Most bots run headless (no valid
   * token of their own) and used to be undeliverable for that reason alone —
   * one live Telegram connection is enough to reach a chat id.
   */
  getAnyTelegramBot?: () => Bot | undefined;
  getWhatsAppConfig: (botId: string) => WhatsAppConfig | undefined;
  sessionManager: SessionManager;
}

/**
 * Append an assistant message to a bot's private web session — the transcript
 * the widget replays on reconnect. Shared by the web outbound channel, the
 * proactive message tool and the cron instruction fallback so the three cannot
 * drift apart on how a session key is derived.
 */
export function appendWebSessionMessage(
  sessionManager: SessionManager,
  botId: string,
  address: string,
  text: string
): void {
  const sessionKey = sessionManager.serializeKey({
    botId,
    chatType: 'private',
    chatId: 0,
    userId: Number(address) || undefined,
  });
  sessionManager.appendMessages(sessionKey, [{ role: 'assistant', content: text }], 100);
}

/**
 * Create an outbound Channel for proactive message delivery.
 * Returns null if the channel type doesn't support push delivery.
 */
export function createOutboundChannel(
  deps: OutboundChannelDeps,
  botId: string,
  contact: ContactChannel
): Channel | null {
  switch (contact.kind) {
    case 'telegram': {
      // A headless bot has no instance of its own; the fleet's live Telegram
      // connection delivers for it. Null stays for the genuinely undeliverable
      // case: no Telegram instance anywhere, or an address that is not a chat id.
      const bot = deps.getTelegramBot(botId) ?? deps.getAnyTelegramBot?.();
      if (!bot) return null;
      const chatId = Number(contact.address);
      if (Number.isNaN(chatId)) return null;
      return {
        kind: 'telegram',
        async sendText(text: string) {
          await bot.api.sendMessage(chatId, text);
        },
        async showTyping() {
          await bot.api.sendChatAction(chatId, 'typing');
        },
      };
    }

    case 'whatsapp': {
      const waConfig = deps.getWhatsAppConfig(botId);
      if (!waConfig) return null;
      return whatsappChannel(contact.address, waConfig);
    }

    case 'web': {
      return {
        kind: 'web',
        async sendText(text: string) {
          appendWebSessionMessage(deps.sessionManager, botId, contact.address, text);
        },
        async showTyping() {
          // no-op — no persistent connection
        },
      };
    }

    case 'discord': {
      // Discord outbound needs the bot token from config
      // For now, return null — Discord outbound requires gateway connection
      return null;
    }

    case 'rest':
    case 'mcp':
      return null;

    default:
      return null;
  }
}

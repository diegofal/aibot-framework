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
  getWhatsAppConfig: (botId: string) => WhatsAppConfig | undefined;
  sessionManager: SessionManager;
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
      const bot = deps.getTelegramBot(botId);
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
      const sessionKey = deps.sessionManager.serializeKey({
        botId,
        chatType: 'private',
        chatId: 0,
        userId: Number(contact.address) || undefined,
      });
      return {
        kind: 'web',
        async sendText(text: string) {
          deps.sessionManager.appendMessages(
            sessionKey,
            [{ role: 'assistant', content: text }],
            100
          );
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

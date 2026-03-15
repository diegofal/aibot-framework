/**
 * Telegram channel adapter — maps grammy Context into channel-agnostic types.
 */
import { type Context, InputFile } from 'grammy';
import type { Channel, InboundMessage } from './types';

/**
 * Build an InboundMessage from a grammy Context.
 */
export function telegramToInbound(
  ctx: Context,
  text: string,
  opts?: {
    images?: string[];
    isVoice?: boolean;
    sessionText?: string;
  }
): InboundMessage {
  const chat = ctx.chat;
  if (!chat) throw new Error('Cannot build InboundMessage: no chat in context');

  return {
    messageId: String(ctx.message?.message_id ?? Date.now()),
    channelKind: 'telegram',
    text,
    chatId: String(chat.id),
    chatType: chat.type as InboundMessage['chatType'],
    sender: {
      id: String(ctx.from?.id ?? 0),
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    },
    images: opts?.images,
    isVoice: opts?.isVoice,
    sessionText: opts?.sessionText,
    threadId: ctx.message?.message_thread_id ? String(ctx.message.message_thread_id) : undefined,
    timestamp: Date.now(),
  };
}

/**
 * Create a Channel that sends replies through a grammy Context.
 */
export function telegramChannel(ctx: Context): Channel {
  const chatId = ctx.chat?.id;
  const channel: Channel & {
    /** Streaming support: send initial message, returns message_id */
    _sendMessage?: (text: string) => Promise<number>;
    /** Streaming support: edit existing message by message_id */
    _editMessage?: (messageId: number, text: string) => Promise<void>;
  } = {
    kind: 'telegram',

    async sendText(text: string) {
      await ctx.reply(text);
    },

    async showTyping() {
      await ctx.replyWithChatAction('typing');
    },

    async sendVoice(audioBuffer: Buffer, filename = 'reply.opus') {
      await ctx.replyWithChatAction('record_voice');
      await ctx.replyWithVoice(new InputFile(new Uint8Array(audioBuffer), filename));
    },

    // Streaming handles for progressive message delivery
    async _sendMessage(text: string): Promise<number> {
      const msg = await ctx.reply(text);
      return msg.message_id;
    },

    async _editMessage(messageId: number, text: string): Promise<void> {
      if (!chatId) return;
      try {
        await ctx.api.editMessageText(chatId, messageId, text);
      } catch {
        // Edit may fail if text unchanged or message deleted
      }
    },
  };

  return channel;
}

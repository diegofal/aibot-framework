/**
 * REST API channel adapter — used by the sync chat endpoint.
 * Each request/response pair represents a single exchange.
 */
import type { Channel, InboundMessage } from './types';

export interface RestChatInput {
  botId: string;
  message: string;
  chatId?: string;
  senderId?: string;
  senderName?: string;
  images?: string[];
  userHash?: string;
}

/**
 * Build an InboundMessage from a REST chat request.
 */
export function restToInbound(input: RestChatInput): InboundMessage {
  return {
    messageId: `rest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channelKind: 'rest',
    text: input.message,
    chatId: input.chatId || `rest-${input.senderId || 'anon'}-${Date.now()}`,
    chatType: 'private',
    sender: {
      id: input.senderId || `anon-${Date.now()}`,
      firstName: input.senderName,
    },
    images: input.images,
    timestamp: Date.now(),
  };
}

/**
 * Create a Channel that collects replies into a buffer.
 * The collected text is returned to the HTTP caller.
 */
export function restCollectChannel(): { channel: Channel; getReply: () => string } {
  const replies: string[] = [];

  const channel: Channel = {
    kind: 'rest',

    async sendText(text: string) {
      replies.push(text);
    },

    async showTyping() {
      // No-op for REST — no persistent connection
    },
  };

  return {
    channel,
    getReply: () => replies.join('\n'),
  };
}

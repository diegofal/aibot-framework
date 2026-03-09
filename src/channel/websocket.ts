/**
 * WebSocket channel adapter — used by the embeddable web widget.
 * Each WebSocket connection represents a chat session.
 */
import type { ServerWebSocket } from 'bun';
import type { Channel, InboundMessage } from './types';

export interface WsChatData {
  type: 'chat';
  botId: string;
  chatId: string;
  senderId: string;
  senderName?: string;
}

/**
 * Build an InboundMessage from a WebSocket chat message.
 */
export function wsToInbound(data: WsChatData, text: string): InboundMessage {
  return {
    messageId: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channelKind: 'web',
    text,
    chatId: data.chatId,
    chatType: 'private',
    sender: {
      id: data.senderId,
      firstName: data.senderName,
    },
    timestamp: Date.now(),
  };
}

/**
 * Create a Channel that sends replies through a WebSocket connection.
 */
export function wsChannel(ws: ServerWebSocket<WsChatData>): Channel {
  return {
    kind: 'web',

    async sendText(text: string) {
      try {
        ws.send(JSON.stringify({ type: 'message', role: 'bot', content: text }));
      } catch {
        // Connection may have closed
      }
    },

    async showTyping() {
      try {
        ws.send(JSON.stringify({ type: 'typing' }));
      } catch {
        // Connection may have closed
      }
    },
  };
}

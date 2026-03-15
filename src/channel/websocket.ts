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
export function wsToInbound(data: WsChatData, text: string, images?: string[]): InboundMessage {
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
    images: images && images.length > 0 ? images : undefined,
    timestamp: Date.now(),
  };
}

/**
 * Create a Channel that sends replies through a WebSocket connection.
 */
export function wsChannel(ws: ServerWebSocket<WsChatData>): Channel {
  const channel: Channel & {
    /** Streaming support: raw WebSocket handle */
    _ws?: ServerWebSocket<WsChatData>;
    /** Send a message with approval metadata for inline confirmation UI */
    sendApproval?: (text: string, approval: { toolName: string; description: string }) => void;
  } = {
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

    /** Send a message with approval metadata so the widget can render approve/deny buttons */
    sendApproval(text: string, approval: { toolName: string; description: string }) {
      try {
        ws.send(JSON.stringify({ type: 'message', role: 'bot', content: text, approval }));
      } catch {
        // Connection may have closed
      }
    },

    // Streaming handle for progressive WebSocket delivery
    _ws: ws,
  };

  return channel;
}

/**
 * Stream LLM output through a WebSocket connection.
 * Sends stream_start → stream_chunk* → stream_end events.
 *
 * @returns The final complete text.
 */
export async function streamToWebSocket(
  ws: ServerWebSocket<WsChatData>,
  stream: AsyncGenerator<string>
): Promise<string> {
  let fullText = '';

  try {
    ws.send(JSON.stringify({ type: 'stream_start' }));
  } catch {
    // Connection may have closed
  }

  for await (const chunk of stream) {
    fullText += chunk;
    try {
      ws.send(JSON.stringify({ type: 'stream_chunk', text: chunk }));
    } catch {
      // Connection may have closed — keep consuming to drain the generator
    }
  }

  try {
    ws.send(JSON.stringify({ type: 'stream_end', fullText }));
  } catch {
    // Connection may have closed
  }

  return fullText;
}

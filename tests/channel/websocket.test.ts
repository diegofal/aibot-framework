import { describe, expect, mock, test } from 'bun:test';
import { wsChannel, wsToInbound } from '../../src/channel/websocket';
import type { WsChatData } from '../../src/channel/websocket';

describe('WebSocket channel', () => {
  const chatData: WsChatData = {
    type: 'chat',
    botId: 'test-bot',
    chatId: 'widget-123',
    senderId: 'user-456',
    senderName: 'Alice',
  };

  describe('wsToInbound', () => {
    test('creates InboundMessage from WsChatData', () => {
      const msg = wsToInbound(chatData, 'Hello there');

      expect(msg.channelKind).toBe('web');
      expect(msg.text).toBe('Hello there');
      expect(msg.chatId).toBe('widget-123');
      expect(msg.chatType).toBe('private');
      expect(msg.sender.id).toBe('user-456');
      expect(msg.sender.firstName).toBe('Alice');
      expect(msg.messageId).toMatch(/^ws-/);
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    test('generates unique messageIds', () => {
      const msg1 = wsToInbound(chatData, 'a');
      const msg2 = wsToInbound(chatData, 'b');
      expect(msg1.messageId).not.toBe(msg2.messageId);
    });
  });

  describe('wsChannel', () => {
    function createMockWs() {
      const sent: string[] = [];
      return {
        ws: {
          send: mock((data: string) => {
            sent.push(data);
          }),
        } as any,
        sent,
      };
    }

    test('sendText sends JSON message via WebSocket', async () => {
      const { ws, sent } = createMockWs();
      const channel = wsChannel(ws);

      await channel.sendText('Hello from bot');

      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed.type).toBe('message');
      expect(parsed.role).toBe('bot');
      expect(parsed.content).toBe('Hello from bot');
    });

    test('showTyping sends typing indicator', async () => {
      const { ws, sent } = createMockWs();
      const channel = wsChannel(ws);

      await channel.showTyping();

      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed.type).toBe('typing');
    });

    test('kind is "web"', () => {
      const { ws } = createMockWs();
      const channel = wsChannel(ws);
      expect(channel.kind).toBe('web');
    });

    test('handles closed connection gracefully', async () => {
      const ws = {
        send: mock(() => {
          throw new Error('Connection closed');
        }),
      } as any;
      const channel = wsChannel(ws);

      // Should not throw
      await channel.sendText('test');
      await channel.showTyping();
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { telegramToInbound } from '../../src/channel';
import type { Channel, InboundMessage } from '../../src/channel/types';

describe('Channel types', () => {
  describe('telegramToInbound', () => {
    test('maps grammy-like context to InboundMessage', () => {
      const mockCtx = {
        chat: { id: 12345, type: 'private' },
        from: { id: 67890, username: 'alice', first_name: 'Alice' },
        message: { message_id: 999, message_thread_id: undefined },
      } as any;

      const msg = telegramToInbound(mockCtx, 'Hello there');

      expect(msg.channelKind).toBe('telegram');
      expect(msg.text).toBe('Hello there');
      expect(msg.chatId).toBe('12345');
      expect(msg.chatType).toBe('private');
      expect(msg.sender.id).toBe('67890');
      expect(msg.sender.username).toBe('alice');
      expect(msg.sender.firstName).toBe('Alice');
      expect(msg.messageId).toBe('999');
    });

    test('includes images and isVoice from opts', () => {
      const mockCtx = {
        chat: { id: 1, type: 'group' },
        from: { id: 2 },
        message: { message_id: 100 },
      } as any;

      const msg = telegramToInbound(mockCtx, 'Voice msg', {
        images: ['base64img'],
        isVoice: true,
        sessionText: 'original caption',
      });

      expect(msg.images).toEqual(['base64img']);
      expect(msg.isVoice).toBe(true);
      expect(msg.sessionText).toBe('original caption');
      expect(msg.chatType).toBe('group');
    });

    test('throws without chat', () => {
      const mockCtx = { chat: undefined, from: { id: 1 }, message: {} } as any;
      expect(() => telegramToInbound(mockCtx, 'test')).toThrow('no chat');
    });

    test('maps thread id for forum topics', () => {
      const mockCtx = {
        chat: { id: 1, type: 'supergroup' },
        from: { id: 2 },
        message: { message_id: 50, message_thread_id: 77 },
      } as any;

      const msg = telegramToInbound(mockCtx, 'topic msg');
      expect(msg.threadId).toBe('77');
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { restCollectChannel, restToInbound } from '../../../src/channel/rest';

describe('REST channel adapter', () => {
  test('restToInbound builds valid InboundMessage', () => {
    const msg = restToInbound({
      botId: 'test-bot',
      message: 'Hello world',
      chatId: 'chat-123',
      senderId: 'user-456',
      senderName: 'John',
    });

    expect(msg.channelKind).toBe('rest');
    expect(msg.text).toBe('Hello world');
    expect(msg.chatId).toBe('chat-123');
    expect(msg.sender.id).toBe('user-456');
    expect(msg.sender.firstName).toBe('John');
    expect(msg.chatType).toBe('private');
    expect(msg.messageId).toMatch(/^rest-/);
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  test('restToInbound generates default chatId and senderId', () => {
    const msg = restToInbound({
      botId: 'test-bot',
      message: 'Hello',
    });

    expect(msg.chatId).toMatch(/^rest-/);
    expect(msg.sender.id).toMatch(/^anon-/);
  });

  test('restToInbound passes through images', () => {
    const msg = restToInbound({
      botId: 'test-bot',
      message: 'Check this',
      images: ['base64image1', 'base64image2'],
    });

    expect(msg.images).toEqual(['base64image1', 'base64image2']);
  });

  test('restCollectChannel collects replies', async () => {
    const { channel, getReply } = restCollectChannel();

    await channel.sendText('Hello');
    await channel.sendText('World');

    expect(getReply()).toBe('Hello\nWorld');
  });

  test('restCollectChannel showTyping is no-op', async () => {
    const { channel } = restCollectChannel();
    await channel.showTyping(); // Should not throw
  });

  test('restCollectChannel kind is rest', () => {
    const { channel } = restCollectChannel();
    expect(channel.kind).toBe('rest');
  });

  test('restCollectChannel returns empty string when no replies', () => {
    const { getReply } = restCollectChannel();
    expect(getReply()).toBe('');
  });
});

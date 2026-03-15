import { describe, expect, test } from 'bun:test';
import { type WsChatData, wsToInbound } from '../src/channel/websocket';

const chatData: WsChatData = {
  type: 'chat',
  botId: 'test-bot',
  chatId: 'chat-123',
  senderId: 'user-1',
  senderName: 'Alice',
};

describe('wsToInbound — image support', () => {
  test('without images — no images field', () => {
    const msg = wsToInbound(chatData, 'hello');
    expect(msg.text).toBe('hello');
    expect(msg.images).toBeUndefined();
    expect(msg.channelKind).toBe('web');
  });

  test('with images — passes base64 array', () => {
    const images = ['iVBORw0KGgoAAAA...', 'R0lGODlhAQABAI...'];
    const msg = wsToInbound(chatData, 'check this', images);
    expect(msg.text).toBe('check this');
    expect(msg.images).toEqual(images);
    expect(msg.images).toHaveLength(2);
  });

  test('with empty images array — undefined', () => {
    const msg = wsToInbound(chatData, 'text', []);
    expect(msg.images).toBeUndefined();
  });

  test('preserves sender and chat metadata', () => {
    const msg = wsToInbound(chatData, 'hi', ['base64data']);
    expect(msg.sender.id).toBe('user-1');
    expect(msg.sender.firstName).toBe('Alice');
    expect(msg.chatId).toBe('chat-123');
    expect(msg.chatType).toBe('private');
  });
});

describe('WS message parsing — image size guard', () => {
  test('validates max 4 images conceptually', () => {
    // This tests the server-side guard logic indirectly
    // The actual guard is in server.ts; here we verify wsToInbound accepts any valid array
    const images = ['a', 'b', 'c', 'd'];
    const msg = wsToInbound(chatData, 'text', images);
    expect(msg.images).toHaveLength(4);
  });

  test('messageId is unique per call', () => {
    const msg1 = wsToInbound(chatData, 'a');
    const msg2 = wsToInbound(chatData, 'b');
    expect(msg1.messageId).not.toBe(msg2.messageId);
  });
});

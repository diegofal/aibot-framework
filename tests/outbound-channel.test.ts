import { describe, expect, test } from 'bun:test';
import { createOutboundChannel } from '../src/channel/outbound';
import type { OutboundChannelDeps } from '../src/channel/outbound';

function makeDeps(overrides: Partial<OutboundChannelDeps> = {}): OutboundChannelDeps {
  return {
    getTelegramBot: () => undefined,
    getWhatsAppConfig: () => undefined,
    sessionManager: {
      serializeKey: (opts: any) => `bot:${opts.botId}:${opts.chatType}:${opts.chatId}`,
      appendMessages: () => {},
    } as any,
    ...overrides,
  };
}

describe('createOutboundChannel', () => {
  test('telegram — creates channel with sendText', async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const bot = {
      api: {
        sendMessage: async (chatId: number, text: string) => {
          sent.push({ chatId, text });
        },
        sendChatAction: async () => {},
      },
    } as any;

    const deps = makeDeps({ getTelegramBot: () => bot });
    const channel = createOutboundChannel(deps, 'bot1', {
      kind: 'telegram',
      address: '12345',
      verified: true,
    });

    expect(channel).not.toBeNull();
    expect(channel?.kind).toBe('telegram');
    await channel?.sendText('Hello!');
    expect(sent).toEqual([{ chatId: 12345, text: 'Hello!' }]);
  });

  test('telegram — returns null when no bot instance', () => {
    const deps = makeDeps();
    const channel = createOutboundChannel(deps, 'bot1', {
      kind: 'telegram',
      address: '12345',
      verified: true,
    });

    expect(channel).toBeNull();
  });

  test('telegram — returns null for non-numeric address', () => {
    const bot = { api: {} } as any;
    const deps = makeDeps({ getTelegramBot: () => bot });
    const channel = createOutboundChannel(deps, 'bot1', {
      kind: 'telegram',
      address: 'not-a-number',
      verified: true,
    });

    expect(channel).toBeNull();
  });

  test('web — creates channel that appends to session', async () => {
    const appended: any[] = [];
    const deps = makeDeps({
      sessionManager: {
        serializeKey: (opts: any) => `bot:${opts.botId}:${opts.chatType}:${opts.userId}`,
        appendMessages: (_key: string, msgs: any[]) => {
          appended.push(...msgs);
        },
      } as any,
    });

    const channel = createOutboundChannel(deps, 'bot1', {
      kind: 'web',
      address: '42',
      verified: true,
    });

    expect(channel).not.toBeNull();
    expect(channel?.kind).toBe('web');
    await channel?.sendText('Hi widget user');
    expect(appended).toHaveLength(1);
    expect(appended[0].role).toBe('assistant');
    expect(appended[0].content).toBe('Hi widget user');
  });

  test('rest — returns null (no push support)', () => {
    const deps = makeDeps();
    const channel = createOutboundChannel(deps, 'bot1', {
      kind: 'rest',
      address: 'req-1',
      verified: true,
    });

    expect(channel).toBeNull();
  });

  test('mcp — returns null (no push support)', () => {
    const deps = makeDeps();
    const channel = createOutboundChannel(deps, 'bot1', {
      kind: 'mcp',
      address: 'session-1',
      verified: true,
    });

    expect(channel).toBeNull();
  });

  test('whatsapp — returns null when no config', () => {
    const deps = makeDeps();
    const channel = createOutboundChannel(deps, 'bot1', {
      kind: 'whatsapp',
      address: '+5491155551234',
      verified: true,
    });

    expect(channel).toBeNull();
  });

  test('whatsapp — creates channel when config available', () => {
    const deps = makeDeps({
      getWhatsAppConfig: () => ({
        phoneNumberId: 'phone-1',
        accessToken: 'token-123',
        verifyToken: 'verify-456',
      }),
    });

    const channel = createOutboundChannel(deps, 'bot1', {
      kind: 'whatsapp',
      address: '+5491155551234',
      verified: true,
    });

    expect(channel).not.toBeNull();
    expect(channel?.kind).toBe('whatsapp');
  });
});

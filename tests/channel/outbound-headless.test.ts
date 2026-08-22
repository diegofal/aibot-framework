/**
 * Headless delivery for outbound channels.
 *
 * `createOutboundChannel` used to resolve the Telegram case through the owning
 * bot's own grammy instance only, so every headless bot (7 of the 8 in
 * production) got `null` back and could not deliver anything. A headless bot
 * can still be delivered through the fleet's live Telegram connection.
 */
import { describe, expect, test } from 'bun:test';
import { appendWebSessionMessage, createOutboundChannel } from '../../src/channel/outbound';
import type { OutboundChannelDeps } from '../../src/channel/outbound';

function makeSessionManager() {
  const appended: Array<{ key: string; messages: unknown[] }> = [];
  return {
    appended,
    serializeKey: (k: Record<string, unknown>) => JSON.stringify(k),
    appendMessages: (key: string, messages: unknown[]) => {
      appended.push({ key, messages });
    },
  };
}

function makeBot(sent: Array<[number, string]>, actions: Array<[number, string]> = []) {
  return {
    api: {
      sendMessage: async (chatId: number, text: string) => {
        sent.push([chatId, text]);
      },
      sendChatAction: async (chatId: number, action: string) => {
        actions.push([chatId, action]);
      },
    },
  };
}

function makeDeps(overrides: Partial<OutboundChannelDeps> = {}): OutboundChannelDeps {
  return {
    getTelegramBot: () => undefined,
    getWhatsAppConfig: () => undefined,
    sessionManager: makeSessionManager() as never,
    ...overrides,
  } as OutboundChannelDeps;
}

describe('createOutboundChannel — headless Telegram fallback', () => {
  test('uses the bot own Telegram instance when it has one', async () => {
    const sent: Array<[number, string]> = [];
    const own = makeBot(sent);
    const fleetSent: Array<[number, string]> = [];
    const deps = makeDeps({
      getTelegramBot: () => own as never,
      getAnyTelegramBot: () => makeBot(fleetSent) as never,
    });

    const channel = createOutboundChannel(deps, 'bot1', { kind: 'telegram', address: '4242' });
    expect(channel).not.toBeNull();
    await channel?.sendText('hi');

    expect(sent).toEqual([[4242, 'hi']]);
    expect(fleetSent).toEqual([]);
  });

  test('falls back to any fleet Telegram instance for a headless bot', async () => {
    const fleetSent: Array<[number, string]> = [];
    const actions: Array<[number, string]> = [];
    const deps = makeDeps({
      getTelegramBot: () => undefined,
      getAnyTelegramBot: () => makeBot(fleetSent, actions) as never,
    });

    const channel = createOutboundChannel(deps, 'headless-bot', {
      kind: 'telegram',
      address: '4242',
    });
    expect(channel).not.toBeNull();
    await channel?.sendText('from a headless bot');
    await channel?.showTyping();

    expect(fleetSent).toEqual([[4242, 'from a headless bot']]);
    expect(actions).toEqual([[4242, 'typing']]);
  });

  test('returns null only when no Telegram instance exists anywhere', () => {
    const deps = makeDeps({ getTelegramBot: () => undefined });
    expect(
      createOutboundChannel(deps, 'headless-bot', { kind: 'telegram', address: '4242' })
    ).toBeNull();
  });

  test('returns null for a non-numeric Telegram address even with a fallback instance', () => {
    const deps = makeDeps({ getAnyTelegramBot: () => makeBot([]) as never });
    expect(
      createOutboundChannel(deps, 'bot1', { kind: 'telegram', address: 'not-a-chat' })
    ).toBeNull();
  });
});

describe('appendWebSessionMessage', () => {
  test('appends an assistant message to the bot private session', () => {
    const sessions = makeSessionManager();
    appendWebSessionMessage(sessions as never, 'bot1', '99', 'queued text');

    expect(sessions.appended).toHaveLength(1);
    expect(JSON.parse(sessions.appended[0].key)).toEqual({
      botId: 'bot1',
      chatType: 'private',
      chatId: 0,
      userId: 99,
    });
    expect(sessions.appended[0].messages).toEqual([{ role: 'assistant', content: 'queued text' }]);
  });

  test('non-numeric addresses leave userId undefined', () => {
    const sessions = makeSessionManager();
    appendWebSessionMessage(sessions as never, 'bot1', 'widget-user', 'text');
    expect(JSON.parse(sessions.appended[0].key).userId).toBeUndefined();
  });

  test('the web outbound channel routes through the same helper', async () => {
    const sessions = makeSessionManager();
    const deps = makeDeps({ sessionManager: sessions as never });
    const channel = createOutboundChannel(deps, 'bot1', { kind: 'web', address: '7' });

    expect(channel?.kind).toBe('web');
    await channel?.sendText('hello');
    await channel?.showTyping();

    expect(sessions.appended).toHaveLength(1);
    expect(sessions.appended[0].messages).toEqual([{ role: 'assistant', content: 'hello' }]);
  });
});

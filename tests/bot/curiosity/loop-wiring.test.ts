import { describe, expect, it } from 'bun:test';
import {
  createFleetDispatchLimiter,
  createOperatorDispatchDeliverer,
} from '../../../src/bot/curiosity/loop-wiring';

const logger = { warn() {}, info() {}, debug() {}, error() {} } as any;

const fakeBot = (sent: Array<[number, string]>, fail = false) => ({
  api: {
    sendMessage: async (chatId: number, text: string) => {
      if (fail) throw new Error('403');
      sent.push([chatId, text]);
    },
  },
});

describe('createOperatorDispatchDeliverer', () => {
  it('sends through the bot’s own Telegram instance to the operator chat', async () => {
    const own: Array<[number, string]> = [];
    const any: Array<[number, string]> = [];
    const deliver = createOperatorDispatchDeliverer({
      getOperatorChatId: () => 42,
      getBot: () => fakeBot(own),
      getAnyBot: () => fakeBot(any),
      logger,
    });
    expect(await deliver('b', 'hello')).toBe('telegram');
    expect(own).toEqual([[42, 'hello']]);
    expect(any).toEqual([]);
  });

  it('falls back to any live instance for headless bots', async () => {
    const any: Array<[number, string]> = [];
    const deliver = createOperatorDispatchDeliverer({
      getOperatorChatId: () => 42,
      getBot: () => undefined,
      getAnyBot: () => fakeBot(any),
      logger,
    });
    expect(await deliver('b', 'hi')).toBe('telegram');
    expect(any).toEqual([[42, 'hi']]);
  });

  it('counts as delivered to the dashboard inbox when there is no Telegram route', async () => {
    const noChat = createOperatorDispatchDeliverer({
      getOperatorChatId: () => undefined,
      getBot: () => undefined,
      getAnyBot: () => undefined,
      logger,
    });
    expect(await noChat('b', 'x')).toBe('inbox');
    const noBot = createOperatorDispatchDeliverer({
      getOperatorChatId: () => 42,
      getBot: () => undefined,
      getAnyBot: () => undefined,
      logger,
    });
    expect(await noBot('b', 'x')).toBe('inbox');
  });

  it('reports failure when Telegram rejects the send', async () => {
    const deliver = createOperatorDispatchDeliverer({
      getOperatorChatId: () => 42,
      getBot: () => fakeBot([], true),
      getAnyBot: () => undefined,
      logger,
    });
    expect(await deliver('b', 'x')).toBe(false);
  });
});

describe('createFleetDispatchLimiter', () => {
  it('enforces the fleet daily cap across bots', () => {
    let t = 0;
    const limiter = createFleetDispatchLimiter(() => 2, () => t);
    expect(limiter.allows('a')).toBe(true);
    limiter.record('a');
    limiter.record('b');
    expect(limiter.allows('c')).toBe(false);
    t += 24 * 3_600_000 + 1;
    expect(limiter.allows('c')).toBe(true);
  });

  it('a cap of 0 disables the limit', () => {
    const limiter = createFleetDispatchLimiter(() => 0);
    for (let i = 0; i < 50; i++) limiter.record('a');
    expect(limiter.allows('a')).toBe(true);
  });
});

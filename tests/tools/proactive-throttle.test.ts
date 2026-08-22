/**
 * Throttle for send_proactive_message.
 *
 * With `chatId: "operator"` resolving for every bot, milei-rocca sent the
 * operator three Telegram messages in 13 minutes. Nothing rate-limited
 * proactive sends; with 8 bots able to resolve the operator that scales badly.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROACTIVE_COOLDOWN_MINUTES,
  DEFAULT_PROACTIVE_DAILY_CAP,
  ProactiveThrottle,
  createSendProactiveMessageTool,
  resolveProactiveLimits,
} from '../../src/tools/send-proactive-message';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

const HOUR = 60 * 60 * 1000;

describe('resolveProactiveLimits', () => {
  test('defaults when the operator block is absent', () => {
    expect(resolveProactiveLimits(undefined)).toEqual({
      cooldownMs: DEFAULT_PROACTIVE_COOLDOWN_MINUTES * 60_000,
      dailyCap: DEFAULT_PROACTIVE_DAILY_CAP,
    });
    expect(DEFAULT_PROACTIVE_COOLDOWN_MINUTES).toBe(60);
    expect(DEFAULT_PROACTIVE_DAILY_CAP).toBe(10);
  });

  test('config overrides both limits', () => {
    expect(resolveProactiveLimits({ proactiveCooldownMinutes: 5, proactiveDailyCap: 2 })).toEqual({
      cooldownMs: 5 * 60_000,
      dailyCap: 2,
    });
  });

  test('zero disables the limit rather than blocking every send', () => {
    const limits = resolveProactiveLimits({ proactiveCooldownMinutes: 0, proactiveDailyCap: 0 });
    expect(limits.cooldownMs).toBe(0);
    expect(limits.dailyCap).toBe(0);
  });
});

describe('ProactiveThrottle', () => {
  function makeThrottle(limits = { cooldownMs: HOUR, dailyCap: 10 }, start = 1_000_000) {
    let now = start;
    const throttle = new ProactiveThrottle(
      () => limits,
      () => now
    );
    const advance = (ms: number) => {
      now += ms;
    };
    return { throttle, advance, at: () => now };
  }

  test('the first send from a bot is allowed', () => {
    const { throttle } = makeThrottle();
    expect(throttle.check('bot1').allowed).toBe(true);
  });

  test('a second send inside the cooldown is refused with the retry time', () => {
    const { throttle, advance, at } = makeThrottle();
    throttle.record('bot1');
    const sentAt = at();
    advance(13 * 60_000);

    const check = throttle.check('bot1');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('bot1 may send again at');
    expect(check.reason).toContain(new Date(sentAt + HOUR).toISOString());
  });

  test('the cooldown is per bot', () => {
    const { throttle } = makeThrottle();
    throttle.record('bot1');
    expect(throttle.check('bot2').allowed).toBe(true);
  });

  test('after the cooldown the same bot may send again', () => {
    const { throttle, advance } = makeThrottle();
    throttle.record('bot1');
    advance(HOUR + 1);
    expect(throttle.check('bot1').allowed).toBe(true);
  });

  test('the fleet cap refuses the 11th send in 24 h', () => {
    const { throttle, advance } = makeThrottle({ cooldownMs: 0, dailyCap: 10 });
    for (let i = 0; i < 10; i++) {
      expect(throttle.check(`bot${i}`).allowed).toBe(true);
      throttle.record(`bot${i}`);
      advance(60_000);
    }

    const check = throttle.check('bot-eleven');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Fleet cap 10/24h, used 10');
    expect(check.reason).toContain('may send again at');
  });

  test('the fleet cap recovers once the oldest send leaves the window', () => {
    const { throttle, advance } = makeThrottle({ cooldownMs: 0, dailyCap: 2 });
    throttle.record('bot1');
    advance(HOUR);
    throttle.record('bot2');
    expect(throttle.check('bot3').allowed).toBe(false);

    advance(23 * HOUR + 1); // first send is now older than 24 h
    expect(throttle.check('bot3').allowed).toBe(true);
  });

  test('a zero cap or cooldown disables that limit', () => {
    const { throttle } = makeThrottle({ cooldownMs: 0, dailyCap: 0 });
    for (let i = 0; i < 50; i++) throttle.record('bot1');
    expect(throttle.check('bot1').allowed).toBe(true);
  });
});

describe('send_proactive_message throttling', () => {
  function makeTool(
    operator: Record<string, unknown> | undefined,
    sent: Array<[number, string]>,
    clock: { now: number }
  ) {
    return createSendProactiveMessageTool({
      sendTelegramMessage: async (chatId, text) => {
        sent.push([chatId, text]);
      },
      appendToSession: () => {},
      getOperator: () => operator as never,
      now: () => clock.now,
    });
  }

  test('a second operator message inside the cooldown is refused', async () => {
    const sent: Array<[number, string]> = [];
    const clock = { now: 1_000_000 };
    const tool = makeTool({ telegramChatId: 796164002 }, sent, clock);

    const first = await tool.execute(
      { chatId: 'operator', message: 'one', _botId: 'milei-rocca' },
      logger
    );
    expect(first.success).toBe(true);

    clock.now += 7 * 60_000;
    const second = await tool.execute(
      { chatId: 'operator', message: 'two', _botId: 'milei-rocca' },
      logger
    );

    expect(second.success).toBe(false);
    expect(second.content).toContain('Proactive send throttled');
    expect(second.content).toContain('milei-rocca may send again at');
    expect(sent).toHaveLength(1);
  });

  test('after the cooldown the send goes through', async () => {
    const sent: Array<[number, string]> = [];
    const clock = { now: 1_000_000 };
    const tool = makeTool({ telegramChatId: 1, proactiveCooldownMinutes: 30 }, sent, clock);

    await tool.execute({ chatId: 'operator', message: 'one', _botId: 'bot1' }, logger);
    clock.now += 30 * 60_000 + 1;
    const again = await tool.execute(
      { chatId: 'operator', message: 'two', _botId: 'bot1' },
      logger
    );

    expect(again.success).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test('the throttle applies to arbitrary numeric chat ids too', async () => {
    const sent: Array<[number, string]> = [];
    const clock = { now: 1_000_000 };
    const tool = makeTool(undefined, sent, clock);

    expect(
      (await tool.execute({ chatId: '4242', message: 'a', _botId: 'bot1' }, logger)).success
    ).toBe(true);
    const second = await tool.execute({ chatId: '4242', message: 'b', _botId: 'bot1' }, logger);
    expect(second.success).toBe(false);
    expect(second.content).toContain('Proactive send throttled');
  });

  test('the fleet cap refuses an 11th send within 24 h and recovers after', async () => {
    const sent: Array<[number, string]> = [];
    const clock = { now: 1_000_000 };
    const tool = makeTool({ telegramChatId: 1, proactiveCooldownMinutes: 0 }, sent, clock);

    for (let i = 0; i < 10; i++) {
      const r = await tool.execute(
        { chatId: 'operator', message: `m${i}`, _botId: `bot${i}` },
        logger
      );
      expect(r.success).toBe(true);
      clock.now += 60_000;
    }

    const capped = await tool.execute(
      { chatId: 'operator', message: 'eleven', _botId: 'bot-x' },
      logger
    );
    expect(capped.success).toBe(false);
    expect(capped.content).toContain('Fleet cap 10/24h, used 10');
    expect(sent).toHaveLength(10);

    clock.now += 24 * HOUR;
    const later = await tool.execute(
      { chatId: 'operator', message: 'next day', _botId: 'bot-x' },
      logger
    );
    expect(later.success).toBe(true);
  });

  test('a failed delivery does not burn the quota', async () => {
    const clock = { now: 1_000_000 };
    let fail = true;
    const tool = createSendProactiveMessageTool({
      sendTelegramMessage: async () => {
        if (fail) throw new Error('Bot blocked');
      },
      appendToSession: () => {},
      getOperator: () => ({ telegramChatId: 1 }) as never,
      now: () => clock.now,
    });

    const first = await tool.execute({ chatId: 'operator', message: 'a', _botId: 'bot1' }, logger);
    expect(first.success).toBe(false);

    fail = false;
    const second = await tool.execute({ chatId: 'operator', message: 'b', _botId: 'bot1' }, logger);
    expect(second.success).toBe(true);
  });

  test('validation failures never reach the throttle', async () => {
    const clock = { now: 1_000_000 };
    const sent: Array<[number, string]> = [];
    const tool = makeTool({ telegramChatId: 1 }, sent, clock);

    expect((await tool.execute({ message: 'no chat' }, logger)).success).toBe(false);
    expect(
      (await tool.execute({ chatId: 'operator', message: 'ok', _botId: 'bot1' }, logger)).success
    ).toBe(true);
  });
});

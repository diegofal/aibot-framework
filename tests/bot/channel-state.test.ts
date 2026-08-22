/**
 * Explicit channel state.
 *
 * Before this existed every bot without a working Telegram token logged the
 * same "Telegram start failed — falling back to headless mode" line, whether
 * the token was revoked by BotFather or was the literal string "nothing".
 * Seven of eight bots in the August 2026 audit fell into that bucket and the
 * dashboard could not tell them apart. These tests pin the five states and
 * the one property that matters operationally: a placeholder token never
 * reaches Telegram.
 */
import { describe, expect, mock, test } from 'bun:test';
import { GrammyError } from 'grammy';
import { AgentRegistry } from '../../src/agent-registry';
import {
  TELEGRAM_CONFLICT_EXPLANATION,
  TELEGRAM_TOKEN_PATTERN,
  channelStateFromStartFailure,
  channelStatusForUnstartedToken,
  classifyTelegramToken,
  resolveChannelStart,
} from '../../src/bot/telegram-errors';
import type { Logger } from '../../src/logger';

const VALID_SHAPE = '123456789:AAHabcdefghijklmnopqrstuvwxyz0123456789';

function grammyError(code: number, description: string): GrammyError {
  return new GrammyError(
    description,
    { ok: false, error_code: code, description } as never,
    'getMe',
    {}
  );
}

interface Recorded {
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
}

function makeLogger(): { logger: Logger; lines: Recorded[] } {
  const lines: Recorded[] = [];
  const record =
    (level: Recorded['level']) =>
    (obj: unknown, msg?: string): void => {
      lines.push({ level, msg: typeof obj === 'string' ? obj : (msg ?? '') });
    };
  const logger = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    child: () => logger,
  } as unknown as Logger;
  return { logger, lines };
}

/** A stand-in for grammy's Bot: the only call that matters here is getMe. */
function makeFakeBot(getMe: () => Promise<unknown>) {
  const getMeMock = mock(getMe);
  return { api: { getMe: getMeMock }, getMeMock };
}

describe('classifyTelegramToken', () => {
  test('empty, null and undefined are missing', () => {
    expect(classifyTelegramToken('')).toBe('missing');
    expect(classifyTelegramToken('   ')).toBe('missing');
    expect(classifyTelegramToken(null)).toBe('missing');
    expect(classifyTelegramToken(undefined)).toBe('missing');
  });

  test('the placeholders from the audit are placeholder, not missing', () => {
    for (const token of ['empty', 'nothing', 'myfirstmillion', 'econ-student', 'TODO']) {
      expect(classifyTelegramToken(token)).toBe('placeholder');
    }
  });

  test('a token with the right prefix but a short secret is still a placeholder', () => {
    expect(classifyTelegramToken('123456:abc')).toBe('placeholder');
    expect(classifyTelegramToken('12345:AAHabcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      'placeholder'
    );
  });

  test('a real-shaped token is shaped (and only Telegram can say more)', () => {
    expect(classifyTelegramToken(VALID_SHAPE)).toBe('shaped');
    expect(classifyTelegramToken(`  ${VALID_SHAPE}  `)).toBe('shaped');
    expect(TELEGRAM_TOKEN_PATTERN.test(VALID_SHAPE)).toBe(true);
  });
});

describe('channelStateFromStartFailure', () => {
  test('401 is revoked', () => {
    expect(channelStateFromStartFailure(grammyError(401, 'Unauthorized'))).toBe('revoked');
    expect(
      channelStateFromStartFailure(new Error('Call to getMe failed (401: Unauthorized)'))
    ).toBe('revoked');
  });

  test('409 and network failures are error, not revoked', () => {
    expect(
      channelStateFromStartFailure(
        grammyError(409, 'Conflict: terminated by other getUpdates request')
      )
    ).toBe('error');
    expect(channelStateFromStartFailure(new Error('fetch failed: ECONNREFUSED'))).toBe('error');
  });
});

describe('channelStatusForUnstartedToken', () => {
  test('placeholder and missing tokens have a deterministic headless status', () => {
    expect(channelStatusForUnstartedToken('nothing')).toEqual({
      kind: 'headless',
      state: 'placeholder',
      lastError: null,
      checkedAt: null,
    });
    expect(channelStatusForUnstartedToken(null)).toEqual({
      kind: 'headless',
      state: 'missing',
      lastError: null,
      checkedAt: null,
    });
  });

  test('a shaped token is unknown until Telegram has been asked', () => {
    expect(channelStatusForUnstartedToken(VALID_SHAPE)).toBeUndefined();
  });
});

describe('resolveChannelStart', () => {
  test('placeholder token: never calls Telegram, starts headless at info level', async () => {
    const { logger, lines } = makeLogger();
    const bot = makeFakeBot(async () => ({ id: 1, username: 'x' }));

    const status = await resolveChannelStart({
      botId: 'myfirstmillion',
      token: 'myfirstmillion',
      logger,
      startTelegram: async () => {
        await bot.api.getMe();
      },
    });

    expect(bot.getMeMock).not.toHaveBeenCalled();
    expect(status.kind).toBe('headless');
    expect(status.state).toBe('placeholder');
    expect(status.lastError).toBeNull();
    expect(typeof status.checkedAt).toBe('string');
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(0);
    expect(
      lines.some((l) => l.level === 'info' && /starting headless \(no Telegram token\)/.test(l.msg))
    ).toBe(true);
  });

  test('missing token (null): same silent headless path, state missing', async () => {
    const { logger, lines } = makeLogger();
    const bot = makeFakeBot(async () => ({ id: 1 }));

    const status = await resolveChannelStart({
      botId: 'econ-student',
      token: null,
      logger,
      startTelegram: async () => {
        await bot.api.getMe();
      },
    });

    expect(bot.getMeMock).not.toHaveBeenCalled();
    expect(status).toMatchObject({ kind: 'headless', state: 'missing', lastError: null });
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(0);
  });

  test('shaped token that Telegram accepts: telegram/ok', async () => {
    const { logger } = makeLogger();
    const bot = makeFakeBot(async () => ({ id: 42, username: 'default_bot' }));

    const status = await resolveChannelStart({
      botId: 'default',
      token: VALID_SHAPE,
      logger,
      startTelegram: async () => {
        await bot.api.getMe();
      },
    });

    expect(bot.getMeMock).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({ kind: 'telegram', state: 'ok', lastError: null });
  });

  test('shaped token rejected with 401: revoked, warned exactly once', async () => {
    const { logger, lines } = makeLogger();
    const bot = makeFakeBot(async () => {
      throw grammyError(401, 'Unauthorized');
    });

    const status = await resolveChannelStart({
      botId: 'cryptik',
      token: VALID_SHAPE,
      logger,
      startTelegram: async () => {
        await bot.api.getMe();
      },
    });

    expect(status.kind).toBe('headless');
    expect(status.state).toBe('revoked');
    expect(status.lastError).toMatch(/401/);
    const warns = lines.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toMatch(/falling back to headless mode/);
  });

  test('shaped token that hits 409: error with the conflict explanation', async () => {
    const { logger } = makeLogger();
    const status = await resolveChannelStart({
      botId: 'default',
      token: VALID_SHAPE,
      logger,
      startTelegram: async () => {
        throw grammyError(409, 'Conflict: terminated by other getUpdates request');
      },
    });

    expect(status.state).toBe('error');
    expect(status.lastError).toBe(TELEGRAM_CONFLICT_EXPLANATION);
  });

  test('checkedAt comes from the injected clock', async () => {
    const { logger } = makeLogger();
    const status = await resolveChannelStart({
      botId: 'b',
      token: '',
      logger,
      startTelegram: async () => {},
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    });
    expect(status.checkedAt).toBe('2026-08-21T12:00:00.000Z');
  });
});

describe('AgentRegistry channel state', () => {
  test('register() keeps the channel status and setChannel() replaces it', () => {
    const registry = new AgentRegistry();
    registry.register({
      botId: 'cryptik',
      name: 'Cryptik',
      skills: [],
      channel: { kind: 'headless', state: 'revoked', lastError: '401', checkedAt: 'now' },
    });
    expect(registry.getByBotId('cryptik')?.channel?.state).toBe('revoked');

    const ok = registry.setChannel('cryptik', {
      kind: 'telegram',
      state: 'ok',
      lastError: null,
      checkedAt: 'later',
    });
    expect(ok).toBe(true);
    expect(registry.getByBotId('cryptik')?.channel).toEqual({
      kind: 'telegram',
      state: 'ok',
      lastError: null,
      checkedAt: 'later',
    });
  });

  test('setChannel() on an unknown bot is a no-op that reports false', () => {
    const registry = new AgentRegistry();
    expect(
      registry.setChannel('ghost', {
        kind: 'headless',
        state: 'missing',
        lastError: null,
        checkedAt: null,
      })
    ).toBe(false);
  });
});

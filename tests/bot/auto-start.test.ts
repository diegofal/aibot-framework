/**
 * Boot-time auto-start policy.
 *
 * The property under test is availability: after any restart, every `enabled`
 * bot must come back without a human, one bad bot must not take the others (or
 * the process) with it, and the operator must retain a way to keep everything
 * off the Telegram tokens during a cutover.
 *
 * Nothing here touches the network — `startBot` is always a stub.
 */
import { describe, expect, test } from 'bun:test';
import {
  AUTO_START_ENV_VAR,
  BotDisabledError,
  autoStartEnabledBots,
  resolveAutoStart,
} from '../../src/bot/auto-start';
import type { BotConfig } from '../../src/config';
import type { Logger } from '../../src/logger';

interface Recorded {
  level: 'info' | 'warn' | 'error' | 'debug';
  obj: unknown;
  msg: string;
}

function makeLogger(): { logger: Logger; lines: Recorded[] } {
  const lines: Recorded[] = [];
  const record =
    (level: Recorded['level']) =>
    (obj: unknown, msg?: string): void => {
      if (typeof obj === 'string') lines.push({ level, obj: undefined, msg: obj });
      else lines.push({ level, obj, msg: msg ?? '' });
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

function bot(id: string, enabled = true): BotConfig {
  return {
    id,
    name: id,
    token: '',
    enabled,
    skills: [],
    disabledSkills: [],
    plan: 'free',
  } as BotConfig;
}

/** Shape of the 409 grammy raises when a second consumer polls the same token. */
function conflictError(): Error & { error_code: number } {
  const err = new Error('Conflict: terminated by other getUpdates request') as Error & {
    error_code: number;
  };
  err.error_code = 409;
  return err;
}

describe('resolveAutoStart', () => {
  test('defaults to on when neither config nor env says otherwise', () => {
    expect(resolveAutoStart({ env: {} })).toEqual({ enabled: true, source: 'config' });
  });

  test('honours startup.autoStartBots: false', () => {
    expect(resolveAutoStart({ configured: false, env: {} })).toEqual({
      enabled: false,
      source: 'config',
    });
  });

  test.each(['false', 'FALSE', '0', 'no', 'off', ' off '])(
    'env %p turns auto-start off, overriding a config that says on',
    (value) => {
      const decision = resolveAutoStart({ configured: true, env: { [AUTO_START_ENV_VAR]: value } });
      expect(decision).toEqual({ enabled: false, source: 'env' });
    }
  );

  test.each(['true', '1', 'yes', 'ON'])(
    'env %p turns auto-start on, overriding a config that says off',
    (value) => {
      const env = { [AUTO_START_ENV_VAR]: value };
      expect(resolveAutoStart({ configured: false, env })).toEqual({
        enabled: true,
        source: 'env',
      });
    }
  );

  test('empty env value falls through to config rather than reading as false', () => {
    expect(resolveAutoStart({ configured: true, env: { [AUTO_START_ENV_VAR]: '' } })).toEqual({
      enabled: true,
      source: 'config',
    });
  });

  test('unparseable env value falls back to config and says so', () => {
    const { logger, lines } = makeLogger();
    expect(
      resolveAutoStart({ configured: true, env: { [AUTO_START_ENV_VAR]: 'maybe' }, logger })
    ).toEqual({ enabled: true, source: 'config' });
    expect(lines.some((l) => l.level === 'warn' && l.msg.includes(AUTO_START_ENV_VAR))).toBe(true);
  });
});

describe('autoStartEnabledBots', () => {
  test('starts enabled bots and skips disabled ones', async () => {
    const { logger } = makeLogger();
    const started: string[] = [];
    const result = await autoStartEnabledBots({
      bots: [bot('a'), bot('b', false), bot('c')],
      startBot: async (b) => {
        started.push(b.id);
      },
      logger,
    });

    expect(started).toEqual(['a', 'c']);
    expect(result.started).toEqual(['a', 'c']);
    expect(result.skippedDisabled).toEqual(['b']);
    expect(result.failed).toEqual([]);
  });

  test('starts nothing when every bot is disabled', async () => {
    const { logger } = makeLogger();
    const started: string[] = [];
    const result = await autoStartEnabledBots({
      bots: [bot('a', false), bot('b', false)],
      startBot: async (b) => {
        started.push(b.id);
      },
      logger,
    });

    expect(started).toEqual([]);
    expect(result.skippedDisabled).toEqual(['a', 'b']);
  });

  test('a bot that fails to start does not block the others and does not reject', async () => {
    const { logger, lines } = makeLogger();
    const started: string[] = [];
    const result = await autoStartEnabledBots({
      bots: [bot('a'), bot('boom'), bot('c')],
      startBot: async (b) => {
        if (b.id === 'boom') throw new Error('soul directory is unreadable');
        started.push(b.id);
      },
      logger,
    });

    expect(started).toEqual(['a', 'c']);
    expect(result.started).toEqual(['a', 'c']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].botId).toBe('boom');
    expect(result.failed[0].conflict).toBe(false);
    expect(lines.some((l) => l.level === 'error' && l.msg.includes('boom'))).toBe(true);
  });

  test('every bot failing is reported loudly, still without throwing', async () => {
    const { logger, lines } = makeLogger();
    const result = await autoStartEnabledBots({
      bots: [bot('a'), bot('b')],
      startBot: async () => {
        throw new Error('nope');
      },
      logger,
    });

    expect(result.started).toEqual([]);
    expect(result.failed.map((f) => f.botId)).toEqual(['a', 'b']);
    expect(lines.some((l) => l.level === 'error' && l.msg.includes('NO agents'))).toBe(true);
  });

  test('Telegram 409 is flagged as a conflict and named in the log', async () => {
    const { logger, lines } = makeLogger();
    const result = await autoStartEnabledBots({
      bots: [bot('a'), bot('b')],
      startBot: async (b) => {
        if (b.id === 'a') throw conflictError();
      },
      logger,
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].conflict).toBe(true);
    expect(result.failed[0].reason).toContain('ANOTHER PROCESS IS ALREADY POLLING');
    // The other bot still came up: a shared-token conflict is per-token.
    expect(result.started).toEqual(['b']);
    const conflictLine = lines.find((l) => l.level === 'error' && l.msg.includes('409'));
    expect(conflictLine?.msg).toContain('ANOTHER PROCESS IS ALREADY POLLING');
  });

  test('a bot already running is skipped rather than started twice', async () => {
    const { logger } = makeLogger();
    const started: string[] = [];
    const result = await autoStartEnabledBots({
      bots: [bot('a'), bot('b')],
      startBot: async (b) => {
        started.push(b.id);
      },
      isRunning: (id) => id === 'a',
      logger,
    });

    expect(started).toEqual(['b']);
    expect(result.skippedAlreadyRunning).toEqual(['a']);
  });

  test('shutdown mid-sequence stops further starts', async () => {
    const { logger, lines } = makeLogger();
    let shuttingDown = false;
    const started: string[] = [];
    const result = await autoStartEnabledBots({
      bots: [bot('a'), bot('b'), bot('c')],
      startBot: async (b) => {
        started.push(b.id);
        if (b.id === 'a') shuttingDown = true;
      },
      isShuttingDown: () => shuttingDown,
      logger,
    });

    expect(started).toEqual(['a']);
    expect(result.notAttempted).toEqual(['b', 'c']);
    expect(lines.some((l) => l.level === 'warn' && l.msg.includes('interrupted by shutdown'))).toBe(
      true
    );
  });

  test('bots are started sequentially, not raced', async () => {
    const { logger } = makeLogger();
    let inFlight = 0;
    let maxInFlight = 0;
    await autoStartEnabledBots({
      bots: [bot('a'), bot('b'), bot('c')],
      startBot: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      logger,
    });

    expect(maxInFlight).toBe(1);
  });
});

describe('BotDisabledError', () => {
  test('names the bot and tells the caller how to proceed', () => {
    const err = new BotDisabledError('asistente');
    expect(err.botId).toBe('asistente');
    expect(err.code).toBe('agent_disabled');
    expect(err.message).toContain('asistente');
    expect(err.message).toContain('enable=true');
    expect(err instanceof Error).toBe(true);
  });
});

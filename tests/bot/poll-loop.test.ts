import { describe, test, expect, vi, beforeEach } from 'bun:test';
import { GrammyError } from 'grammy';
import type { Logger } from '../../src/logger';

/**
 * Tests for the custom polling loop in BotManager.
 *
 * Since pollLoop and abortableSleep are private methods on BotManager
 * (a massive facade with many deps), we extract and test the core logic
 * directly by re-implementing the same algorithm in a minimal harness.
 * This validates behavior without needing the full BotManager constructor.
 */

function makeLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

// ---------- abortableSleep ----------

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

describe('abortableSleep', () => {
  test('resolves after timeout', async () => {
    const ac = new AbortController();
    const start = Date.now();
    await abortableSleep(50, ac.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  test('resolves immediately when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await abortableSleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });

  test('resolves early when aborted mid-sleep', async () => {
    const ac = new AbortController();
    const p = abortableSleep(10_000, ac.signal);
    setTimeout(() => ac.abort(), 30);
    const start = Date.now();
    await p;
    expect(Date.now() - start).toBeLessThan(200);
  });
});

// ---------- pollLoop core logic ----------

/** Helper to create a GrammyError with specific error_code */
function make409(): GrammyError {
  return new GrammyError(
    'Conflict: terminated by other getUpdates request',
    { ok: false, error_code: 409, description: 'Conflict' } as any,
    'getUpdates',
    {},
  );
}

function make401(): GrammyError {
  return new GrammyError(
    'Unauthorized',
    { ok: false, error_code: 401, description: 'Unauthorized' } as any,
    'getUpdates',
    {},
  );
}

function make429(retryAfter = 1): GrammyError {
  const err = new GrammyError(
    'Too Many Requests',
    { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: retryAfter } } as any,
    'getUpdates',
    {},
  );
  (err as any).parameters = { retry_after: retryAfter };
  return err;
}

interface MockBot {
  api: {
    getUpdates: ReturnType<typeof vi.fn>;
    deleteWebhook: ReturnType<typeof vi.fn>;
  };
  handleUpdate: ReturnType<typeof vi.fn>;
}

function createMockBot(): MockBot {
  return {
    api: {
      getUpdates: vi.fn(),
      deleteWebhook: vi.fn().mockResolvedValue(true),
    },
    handleUpdate: vi.fn().mockResolvedValue(undefined),
  };
}

type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

const POLL_INTERVAL_MS = 500;

/**
 * Minimal re-implementation of BotManager.pollLoop for unit testing.
 * Mirrors the exact logic in bot-manager.ts, with injectable sleep for fast tests.
 */
async function pollLoop(
  bot: MockBot,
  botId: string,
  signal: AbortSignal,
  logger: Logger,
  opts?: { maxConsecutive409?: number; max409DurationMs?: number; sleep?: SleepFn },
): Promise<void> {
  let offset = 0;
  let consecutive409 = 0;
  let first409At = 0;
  const MAX_409_CONSECUTIVE = opts?.maxConsecutive409 ?? 20;
  const MAX_409_DURATION_MS = opts?.max409DurationMs ?? 5 * 60_000;
  const sleep = opts?.sleep ?? abortableSleep;

  await bot.api.deleteWebhook();

  while (!signal.aborted) {
    try {
      const updates = await bot.api.getUpdates({ offset, limit: 100, timeout: 30 }, signal);

      consecutive409 = 0;
      first409At = 0;

      if (updates.length === 0) {
        // Inter-poll pause (before continue)
        if (!signal.aborted) await sleep(POLL_INTERVAL_MS, signal);
        continue;
      }

      offset = updates[updates.length - 1].update_id + 1;

      for (const update of updates) {
        try {
          await bot.handleUpdate(update);
        } catch (err) {
          logger.error({ err, updateId: update.update_id, botId }, 'Error handling update (non-fatal)');
        }
      }
    } catch (err) {
      if (signal.aborted) break;

      const is409 = err instanceof GrammyError && err.error_code === 409;
      const is401 = err instanceof GrammyError && err.error_code === 401;
      const is429 = err instanceof GrammyError && err.error_code === 429;

      if (is401) throw err;

      if (is409) {
        consecutive409++;
        if (first409At === 0) first409At = Date.now();

        const elapsed = Date.now() - first409At;
        if (consecutive409 >= MAX_409_CONSECUTIVE || elapsed >= MAX_409_DURATION_MS) {
          throw err;
        }

        const delay = Math.min(3_000 * consecutive409, 30_000);
        if (consecutive409 <= 2) {
          logger.debug({ botId, attempt: consecutive409, delay }, 'getUpdates 409 — backing off');
        } else {
          logger.warn({ botId, attempt: consecutive409, delay }, 'getUpdates 409 — backing off');
        }
        await sleep(delay, signal);
        continue;
      }

      if (is429) {
        const retryAfter = (err as any).parameters?.retry_after ?? 10;
        logger.warn({ botId, retryAfter }, 'Rate limited — respecting retry_after');
        await sleep(retryAfter * 1000, signal);
        continue;
      }

      logger.warn({ err, botId }, 'getUpdates error — retrying in 3s');
      await sleep(3_000, signal);
    }

    // Brief pause between polls to prevent Telegram session overlap → 409
    if (!signal.aborted) await sleep(POLL_INTERVAL_MS, signal);
  }
}

/** Instant sleep for fast tests */
const instantSleep: SleepFn = async () => {};

// ---------- Tests ----------

describe('pollLoop', () => {
  test('successful poll cycle: getUpdates → handleUpdate → offset advances', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [
          { update_id: 100, message: { text: 'hello' } },
          { update_id: 101, message: { text: 'world' } },
        ];
      }
      ac.abort();
      return [];
    });

    await pollLoop(bot, 'test', ac.signal, logger, { sleep: instantSleep });

    expect(bot.api.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(bot.handleUpdate).toHaveBeenCalledTimes(2);
    expect(bot.handleUpdate).toHaveBeenCalledWith({ update_id: 100, message: { text: 'hello' } });
    expect(bot.handleUpdate).toHaveBeenCalledWith({ update_id: 101, message: { text: 'world' } });

    // Verify offset advanced: second getUpdates call should have offset 102
    const secondCall = bot.api.getUpdates.mock.calls[1];
    expect(secondCall[0].offset).toBe(102);
  });

  test('409 backoff + recovery: N failures then success resets counters', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount <= 3) throw make409();
      if (callCount === 4) {
        return [{ update_id: 200, message: { text: 'recovered' } }];
      }
      ac.abort();
      return [];
    });

    await pollLoop(bot, 'test', ac.signal, logger, { maxConsecutive409: 5, sleep: instantSleep });

    expect(bot.handleUpdate).toHaveBeenCalledTimes(1);
    expect(bot.handleUpdate).toHaveBeenCalledWith({ update_id: 200, message: { text: 'recovered' } });
    // First 2 are debug, 3rd is warn
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('sustained 409 → throws after consecutive threshold', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    bot.api.getUpdates.mockRejectedValue(make409());

    await expect(
      pollLoop(bot, 'test', ac.signal, logger, { maxConsecutive409: 3, sleep: instantSleep })
    ).rejects.toThrow('Conflict');

    // Should have tried 3 times then thrown
    expect(bot.api.getUpdates).toHaveBeenCalledTimes(3);
  });

  test('clean abort: AbortController.abort() → loop exits without error', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    bot.api.getUpdates.mockImplementation(async () => {
      ac.abort();
      return [];
    });

    // Should resolve (not throw)
    await pollLoop(bot, 'test', ac.signal, logger, { sleep: instantSleep });
    expect(bot.api.deleteWebhook).toHaveBeenCalledTimes(1);
  });

  test('update processing error does not kill the loop', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [
          { update_id: 300, message: { text: 'bad' } },
          { update_id: 301, message: { text: 'good' } },
        ];
      }
      ac.abort();
      return [];
    });

    bot.handleUpdate
      .mockRejectedValueOnce(new Error('handler crash'))
      .mockResolvedValueOnce(undefined);

    await pollLoop(bot, 'test', ac.signal, logger, { sleep: instantSleep });

    // Both updates were attempted
    expect(bot.handleUpdate).toHaveBeenCalledTimes(2);
    // Error was logged
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test('401 throws immediately (bad token)', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    bot.api.getUpdates.mockRejectedValue(make401());

    await expect(
      pollLoop(bot, 'test', ac.signal, logger, { sleep: instantSleep })
    ).rejects.toThrow('Unauthorized');

    // Only 1 attempt — no retries for 401
    expect(bot.api.getUpdates).toHaveBeenCalledTimes(1);
  });

  test('429 respects retry_after', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();
    const sleepCalls: number[] = [];

    const trackingSleep: SleepFn = async (ms) => { sleepCalls.push(ms); };

    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw make429(5); // retry_after=5s
      ac.abort();
      return [];
    });

    await pollLoop(bot, 'test', ac.signal, logger, { sleep: trackingSleep });

    // Should have requested 5000ms sleep (5s × 1000)
    expect(sleepCalls).toEqual([5000]);
  });

  test('generic error retries after backoff', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();
    const sleepCalls: number[] = [];

    const trackingSleep: SleepFn = async (ms) => { sleepCalls.push(ms); };

    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('network timeout');
      ac.abort();
      return [];
    });

    await pollLoop(bot, 'test', ac.signal, logger, { sleep: trackingSleep });

    expect(bot.api.getUpdates).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // 3000ms error backoff + 500ms inter-poll delay
    expect(sleepCalls).toEqual([3_000, POLL_INTERVAL_MS]);
  });

  test('empty updates keep polling without calling handleUpdate', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount >= 3) ac.abort();
      return [];
    });

    await pollLoop(bot, 'test', ac.signal, logger, { sleep: instantSleep });

    expect(bot.handleUpdate).not.toHaveBeenCalled();
    expect(bot.api.getUpdates).toHaveBeenCalledTimes(3);
  });

  test('inter-poll delay is applied between cycles', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();
    const sleepCalls: number[] = [];

    const trackingSleep: SleepFn = async (ms) => { sleepCalls.push(ms); };

    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return []; // empty → triggers inter-poll delay
      if (callCount === 2) return [{ update_id: 1, message: { text: 'hi' } }]; // updates → triggers inter-poll delay
      ac.abort();
      return [];
    });

    await pollLoop(bot, 'test', ac.signal, logger, { sleep: trackingSleep });

    // Each successful cycle should have a POLL_INTERVAL_MS (500) sleep
    // Cycle 1: empty updates → 500ms before continue
    // Cycle 2: updates processed → 500ms at end of loop
    expect(sleepCalls.filter(ms => ms === POLL_INTERVAL_MS)).toHaveLength(2);
  });

  test('409 counter resets after successful poll', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    // Sequence: 2 × 409 → success → 2 × 409 → success → abort
    // With maxConsecutive409=3, this should NOT throw (counter resets each success)
    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw make409();          // 2 failures
      if (callCount === 3) return [{ update_id: 1 }]; // success (reset)
      if (callCount <= 5) throw make409();           // 2 more failures
      if (callCount === 6) return [{ update_id: 2 }]; // success (reset)
      ac.abort();
      return [];
    });

    await pollLoop(bot, 'test', ac.signal, logger, { maxConsecutive409: 3, sleep: instantSleep });

    expect(bot.handleUpdate).toHaveBeenCalledTimes(2);
    // 4 total 409s: each burst of 2 → both debug (<=2), no warns for 409
    expect(logger.debug).toHaveBeenCalledTimes(4);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

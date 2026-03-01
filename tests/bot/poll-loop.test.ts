import { describe, expect, test, vi } from 'bun:test';
import { GrammyError } from 'grammy';
import { type SleepFn, TelegramPoller, abortableSleep } from '../../src/bot/telegram-poller';
import type { Logger } from '../../src/logger';

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

// ---------- Helpers ----------

function make409(): GrammyError {
  return new GrammyError(
    'Conflict: terminated by other getUpdates request',
    { ok: false, error_code: 409, description: 'Conflict' } as any,
    'getUpdates',
    {}
  );
}

function make401(): GrammyError {
  return new GrammyError(
    'Unauthorized',
    { ok: false, error_code: 401, description: 'Unauthorized' } as any,
    'getUpdates',
    {}
  );
}

function make429(retryAfter = 1): GrammyError {
  const err = new GrammyError(
    'Too Many Requests',
    {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: retryAfter },
    } as any,
    'getUpdates',
    {}
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

/** Instant sleep for fast tests */
const instantSleep: SleepFn = async () => {};

const POLL_INTERVAL_MS = 500;

// ---------- Tests ----------

describe('TelegramPoller', () => {
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

    const poller = new TelegramPoller(logger, { sleep: instantSleep });
    await poller.start(bot as any, 'test', ac.signal);

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

    const poller = new TelegramPoller(logger, { sleep: instantSleep });
    await poller.start(bot as any, 'test', ac.signal);

    expect(bot.handleUpdate).toHaveBeenCalledTimes(1);
    expect(bot.handleUpdate).toHaveBeenCalledWith({
      update_id: 200,
      message: { text: 'recovered' },
    });
    // First 2 are debug, 3rd is warn
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('sustained 409 → throws after consecutive threshold', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    bot.api.getUpdates.mockRejectedValue(make409());

    const poller = new TelegramPoller(logger, { sleep: instantSleep });
    await expect(poller.start(bot as any, 'test', ac.signal)).rejects.toThrow('Conflict');

    // Should have tried 20 times (default MAX_409_CONSECUTIVE) then thrown
    expect(bot.api.getUpdates).toHaveBeenCalledTimes(20);
  });

  test('clean abort: AbortController.abort() → loop exits without error', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    bot.api.getUpdates.mockImplementation(async () => {
      ac.abort();
      return [];
    });

    const poller = new TelegramPoller(logger, { sleep: instantSleep });
    await poller.start(bot as any, 'test', ac.signal);
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

    const poller = new TelegramPoller(logger, { sleep: instantSleep });
    await poller.start(bot as any, 'test', ac.signal);

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

    const poller = new TelegramPoller(logger, { sleep: instantSleep });
    await expect(poller.start(bot as any, 'test', ac.signal)).rejects.toThrow('Unauthorized');

    // Only 1 attempt — no retries for 401
    expect(bot.api.getUpdates).toHaveBeenCalledTimes(1);
  });

  test('429 respects retry_after', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();
    const sleepCalls: number[] = [];

    const trackingSleep: SleepFn = async (ms) => {
      sleepCalls.push(ms);
    };

    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw make429(5); // retry_after=5s
      ac.abort();
      return [];
    });

    const poller = new TelegramPoller(logger, { sleep: trackingSleep });
    await poller.start(bot as any, 'test', ac.signal);

    // Should have requested 5000ms sleep (5s × 1000)
    expect(sleepCalls).toEqual([5000]);
  });

  test('generic error retries after backoff', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();
    const sleepCalls: number[] = [];

    const trackingSleep: SleepFn = async (ms) => {
      sleepCalls.push(ms);
    };

    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('network timeout');
      ac.abort();
      return [];
    });

    const poller = new TelegramPoller(logger, { sleep: trackingSleep });
    await poller.start(bot as any, 'test', ac.signal);

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

    const poller = new TelegramPoller(logger, { sleep: instantSleep });
    await poller.start(bot as any, 'test', ac.signal);

    expect(bot.handleUpdate).not.toHaveBeenCalled();
    expect(bot.api.getUpdates).toHaveBeenCalledTimes(3);
  });

  test('inter-poll delay is applied between cycles', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();
    const sleepCalls: number[] = [];

    const trackingSleep: SleepFn = async (ms) => {
      sleepCalls.push(ms);
    };

    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return []; // empty → triggers inter-poll delay
      if (callCount === 2) return [{ update_id: 1, message: { text: 'hi' } }]; // updates → triggers inter-poll delay
      ac.abort();
      return [];
    });

    const poller = new TelegramPoller(logger, { sleep: trackingSleep });
    await poller.start(bot as any, 'test', ac.signal);

    // Each successful cycle should have a POLL_INTERVAL_MS (500) sleep
    expect(sleepCalls.filter((ms) => ms === POLL_INTERVAL_MS)).toHaveLength(2);
  });

  test('409 counter resets after successful poll', async () => {
    const bot = createMockBot();
    const ac = new AbortController();
    const logger = makeLogger();

    // Sequence: 2 × 409 → success → 2 × 409 → success → abort
    let callCount = 0;
    bot.api.getUpdates.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw make409(); // 2 failures
      if (callCount === 3) return [{ update_id: 1 }]; // success (reset)
      if (callCount <= 5) throw make409(); // 2 more failures
      if (callCount === 6) return [{ update_id: 2 }]; // success (reset)
      ac.abort();
      return [];
    });

    const poller = new TelegramPoller(logger, { sleep: instantSleep });
    await poller.start(bot as any, 'test', ac.signal);

    expect(bot.handleUpdate).toHaveBeenCalledTimes(2);
    // 4 total 409s: each burst of 2 → both debug (<=2), no warns for 409
    expect(logger.debug).toHaveBeenCalledTimes(4);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

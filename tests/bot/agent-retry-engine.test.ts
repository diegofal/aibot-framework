import { beforeEach, describe, expect, test, vi } from 'bun:test';
import type { AgentLoopResult } from '../../src/bot/agent-loop';
import {
  computeRetryDelay,
  executeSingleBotWithRetry,
  isRetryableError,
  resolveRetryConfig,
} from '../../src/bot/agent-retry-engine';
import type { AgentLoopRetryConfig, BotConfig } from '../../src/config';
import type { Logger } from '../../src/logger';

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: () => noopLogger,
} as unknown as Logger;

/** Minimal BotConfig factory */
function makeBotConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    name: 'test-bot',
    token: 'fake-token',
    chatId: 123,
    skills: [],
    disabledSkills: [],
    conversation: {} as any,
    agentLoop: {} as any,
    productions: {} as any,
    plan: 'free',
    ...overrides,
  } as BotConfig;
}

/** Minimal successful AgentLoopResult */
function makeResult(partial?: Partial<AgentLoopResult>): AgentLoopResult {
  return {
    botId: 'bot1',
    botName: 'test-bot',
    status: 'completed',
    summary: 'All good',
    durationMs: 100,
    plannerReasoning: '',
    plan: [],
    toolCalls: [],
    strategistRan: false,
    ...partial,
  };
}

/** Minimal error AgentLoopResult */
function makeErrorResult(summary: string, partial?: Partial<AgentLoopResult>): AgentLoopResult {
  return makeResult({ status: 'error', summary, ...partial });
}

const defaultRetryConfig: AgentLoopRetryConfig = {
  maxRetries: 2,
  initialDelayMs: 10_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------
describe('isRetryableError', () => {
  describe('timeout patterns', () => {
    test.each(['Request timed out', 'Connection TIMEOUT after 30s', 'ETIMEDOUT: connect failed'])(
      'returns true for timeout: %s',
      (msg) => {
        expect(isRetryableError(new Error(msg))).toBe(true);
      }
    );
  });

  describe('network patterns', () => {
    test.each([
      'ECONNRESET by peer',
      'ECONNREFUSED 127.0.0.1:443',
      'ENOTFOUND api.example.com',
      'EAI_AGAIN dns lookup failed',
      'socket hang up',
      'network error occurred',
      'fetch failed',
      'request abort',
    ])('returns true for network error: %s', (msg) => {
      expect(isRetryableError(new Error(msg))).toBe(true);
    });
  });

  describe('rate limit patterns', () => {
    test.each([
      'rate limit exceeded',
      'HTTP 429 Too Many Requests',
      'Error 502 Bad Gateway',
      'Error 503 Service Unavailable',
      'Error 504 Gateway Timeout',
    ])('returns true for rate limit / server error: %s', (msg) => {
      expect(isRetryableError(new Error(msg))).toBe(true);
    });
  });

  describe('non-retryable auth/permission patterns', () => {
    test.each([
      'authentication failed',
      'permission denied',
      'forbidden resource',
      'HTTP 401 Unauthorized',
      'HTTP 403 Forbidden',
      'invalid api key provided',
      'invalid_api_key',
      'not found config for bot',
    ])('returns false for auth/permission error: %s', (msg) => {
      expect(isRetryableError(new Error(msg))).toBe(false);
    });
  });

  describe('non-retryable takes priority over retryable', () => {
    test('auth + timeout => non-retryable wins', () => {
      // "auth" is checked first in NON_RETRYABLE_PATTERNS
      expect(isRetryableError(new Error('auth timeout'))).toBe(false);
    });

    test('forbidden + network => non-retryable wins', () => {
      expect(isRetryableError(new Error('forbidden network call'))).toBe(false);
    });
  });

  describe('unknown errors', () => {
    // classifyError returns UNKNOWN for unrecognized errors, which is retryable
    // (conservative: retry unknown errors rather than permanently failing)
    test('returns true for generic error (UNKNOWN is retryable)', () => {
      expect(isRetryableError(new Error('Something went wrong'))).toBe(true);
    });

    test('returns true for empty error (UNKNOWN is retryable)', () => {
      expect(isRetryableError(new Error(''))).toBe(true);
    });

    test('handles non-Error values', () => {
      expect(isRetryableError('timeout string')).toBe(true);
      expect(isRetryableError('random string')).toBe(true); // UNKNOWN → retryable
      expect(isRetryableError(42)).toBe(true); // UNKNOWN → retryable
      expect(isRetryableError(null)).toBe(true); // UNKNOWN → retryable
      expect(isRetryableError(undefined)).toBe(true); // UNKNOWN → retryable
    });
  });
});

// ---------------------------------------------------------------------------
// computeRetryDelay
// ---------------------------------------------------------------------------
describe('computeRetryDelay', () => {
  test('returns base delay on attempt 0 (within jitter range)', () => {
    const delay = computeRetryDelay(0, 10_000, 60_000, 2);
    // base = min(10000 * 2^0, 60000) = 10000
    // jitter range: 10000 ± 20% => [8000, 12000]
    expect(delay).toBeGreaterThanOrEqual(8000);
    expect(delay).toBeLessThanOrEqual(12000);
  });

  test('applies exponential backoff with multiplier', () => {
    // attempt=2, base = min(10000 * 2^2, 60000) = 40000
    // jitter range: 40000 ± 20% => [32000, 48000]
    const delay = computeRetryDelay(2, 10_000, 60_000, 2);
    expect(delay).toBeGreaterThanOrEqual(32000);
    expect(delay).toBeLessThanOrEqual(48000);
  });

  test('caps at maxDelayMs', () => {
    // attempt=5, base = min(10000 * 2^5, 60000) = min(320000, 60000) = 60000
    // jitter range: 60000 ± 20% => [48000, 72000]
    const delay = computeRetryDelay(5, 10_000, 60_000, 2);
    expect(delay).toBeGreaterThanOrEqual(48000);
    expect(delay).toBeLessThanOrEqual(72000);
  });

  test('respects custom multiplier', () => {
    // multiplier=3, attempt=1, base = min(5000 * 3^1, 100000) = 15000
    // jitter range: 15000 ± 20% => [12000, 18000]
    const delay = computeRetryDelay(1, 5_000, 100_000, 3);
    expect(delay).toBeGreaterThanOrEqual(12000);
    expect(delay).toBeLessThanOrEqual(18000);
  });

  test('never returns negative', () => {
    // Even with negative jitter, Math.max(0, ...) prevents negatives
    for (let i = 0; i < 50; i++) {
      const delay = computeRetryDelay(0, 1000, 60000, 2);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  test('jitter adds variability across runs', () => {
    const results = new Set<number>();
    for (let i = 0; i < 30; i++) {
      results.add(computeRetryDelay(0, 10_000, 60_000, 2));
    }
    // With random jitter, we should get more than 1 unique value
    expect(results.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// resolveRetryConfig
// ---------------------------------------------------------------------------
describe('resolveRetryConfig', () => {
  const globalDefaults: AgentLoopRetryConfig = {
    maxRetries: 2,
    initialDelayMs: 10_000,
    maxDelayMs: 60_000,
    backoffMultiplier: 2,
  };

  test('returns global defaults when bot has no agentLoop override', () => {
    const bot = makeBotConfig({ agentLoop: undefined as any });
    const result = resolveRetryConfig(globalDefaults, bot);
    expect(result).toEqual(globalDefaults);
  });

  test('returns global defaults when bot has no retry override', () => {
    const bot = makeBotConfig({ agentLoop: {} as any });
    const result = resolveRetryConfig(globalDefaults, bot);
    expect(result).toEqual(globalDefaults);
  });

  test('applies full per-bot retry overrides', () => {
    const bot = makeBotConfig({
      agentLoop: {
        retry: {
          maxRetries: 5,
          initialDelayMs: 20_000,
          maxDelayMs: 120_000,
          backoffMultiplier: 3,
        },
      } as any,
    });
    const result = resolveRetryConfig(globalDefaults, bot);
    expect(result).toEqual({
      maxRetries: 5,
      initialDelayMs: 20_000,
      maxDelayMs: 120_000,
      backoffMultiplier: 3,
    });
  });

  test('merges partial per-bot overrides with global defaults', () => {
    const bot = makeBotConfig({
      agentLoop: {
        retry: {
          maxRetries: 5,
          // initialDelayMs, maxDelayMs, backoffMultiplier not set => use global
        },
      } as any,
    });
    const result = resolveRetryConfig(globalDefaults, bot);
    expect(result).toEqual({
      maxRetries: 5,
      initialDelayMs: 10_000,
      maxDelayMs: 60_000,
      backoffMultiplier: 2,
    });
  });

  test('partial override of only backoffMultiplier', () => {
    const bot = makeBotConfig({
      agentLoop: {
        retry: {
          backoffMultiplier: 4,
        },
      } as any,
    });
    const result = resolveRetryConfig(globalDefaults, bot);
    expect(result).toEqual({
      maxRetries: 2,
      initialDelayMs: 10_000,
      maxDelayMs: 60_000,
      backoffMultiplier: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// executeSingleBotWithRetry
// ---------------------------------------------------------------------------
describe('executeSingleBotWithRetry', () => {
  let mockOpts: {
    executeFn: ReturnType<typeof vi.fn>;
    getSchedule: ReturnType<typeof vi.fn>;
    sleepFn: ReturnType<typeof vi.fn>;
    isEnabled: ReturnType<typeof vi.fn>;
    isBotRunning: ReturnType<typeof vi.fn>;
  };

  let schedule: { retryCount: number; lastErrorMessage: string | null };
  let botConfig: BotConfig;
  let retryConfig: AgentLoopRetryConfig;

  beforeEach(() => {
    schedule = { retryCount: 0, lastErrorMessage: null };
    botConfig = makeBotConfig();
    retryConfig = { ...defaultRetryConfig };

    mockOpts = {
      executeFn: vi.fn(),
      getSchedule: vi.fn().mockReturnValue(schedule),
      sleepFn: vi.fn().mockResolvedValue(undefined),
      isEnabled: vi.fn().mockReturnValue(true),
      isBotRunning: vi.fn().mockReturnValue(true),
    };

    // Reset logger mocks
    (noopLogger.info as ReturnType<typeof vi.fn>).mockClear();
    (noopLogger.warn as ReturnType<typeof vi.fn>).mockClear();
    (noopLogger.error as ReturnType<typeof vi.fn>).mockClear();
  });

  test('success on first attempt — no retries needed', async () => {
    const successResult = makeResult();
    mockOpts.executeFn.mockResolvedValueOnce(successResult);

    const result = await executeSingleBotWithRetry(
      'bot1',
      botConfig,
      retryConfig,
      noopLogger,
      mockOpts
    );

    expect(result.status).toBe('completed');
    expect(result.retryAttempt).toBeUndefined();
    expect(mockOpts.executeFn).toHaveBeenCalledTimes(1);
    expect(mockOpts.sleepFn).not.toHaveBeenCalled();
    expect(schedule.retryCount).toBe(0);
    expect(schedule.lastErrorMessage).toBeNull();
  });

  test('success after retry — recovers from transient error', async () => {
    const errorResult = makeErrorResult('Connection ETIMEDOUT');
    const successResult = makeResult();

    mockOpts.executeFn.mockResolvedValueOnce(errorResult).mockResolvedValueOnce(successResult);

    const result = await executeSingleBotWithRetry(
      'bot1',
      botConfig,
      retryConfig,
      noopLogger,
      mockOpts
    );

    expect(result.status).toBe('completed');
    expect(result.retryAttempt).toBe(1);
    expect(mockOpts.executeFn).toHaveBeenCalledTimes(2);
    expect(mockOpts.sleepFn).toHaveBeenCalledTimes(1);
    // After recovery: schedule resets
    expect(schedule.retryCount).toBe(0);
    expect(schedule.lastErrorMessage).toBeNull();
  });

  test('non-retryable error skips retry immediately', async () => {
    const authError = makeErrorResult('authentication failed');
    mockOpts.executeFn.mockResolvedValueOnce(authError);

    const result = await executeSingleBotWithRetry(
      'bot1',
      botConfig,
      retryConfig,
      noopLogger,
      mockOpts
    );

    expect(result.status).toBe('error');
    expect(result.summary).toBe('authentication failed');
    expect(mockOpts.executeFn).toHaveBeenCalledTimes(1);
    expect(mockOpts.sleepFn).not.toHaveBeenCalled();
    expect(schedule.retryCount).toBe(0);
    expect(schedule.lastErrorMessage).toBe('authentication failed');
  });

  test('all retries exhausted — returns last error result', async () => {
    const errorResult = makeErrorResult('ECONNRESET by peer');
    mockOpts.executeFn.mockResolvedValue(errorResult);

    const result = await executeSingleBotWithRetry(
      'bot1',
      botConfig,
      retryConfig,
      noopLogger,
      mockOpts
    );

    expect(result.status).toBe('error');
    // maxRetries=2 => attempts 0,1,2 => 3 calls total
    expect(mockOpts.executeFn).toHaveBeenCalledTimes(3);
    expect(mockOpts.sleepFn).toHaveBeenCalledTimes(2);
    expect(result.retryAttempt).toBe(2);
    expect(schedule.retryCount).toBe(retryConfig.maxRetries);
    expect(schedule.lastErrorMessage).toBe('ECONNRESET by peer');
  });

  test('bot stopped during retry — returns last error result', async () => {
    // Stop on the second iteration
    let callCount = 0;
    mockOpts.isBotRunning.mockImplementation(() => {
      callCount++;
      return callCount <= 1;
    });

    const errorResult = makeErrorResult('timeout');
    mockOpts.executeFn.mockResolvedValueOnce(errorResult);

    const result = await executeSingleBotWithRetry(
      'bot1',
      botConfig,
      retryConfig,
      noopLogger,
      mockOpts
    );

    // First attempt: bot running, execute returns error
    // Second attempt: bot not running => returns lastResult (the error)
    expect(result.status).toBe('error');
    expect(result.summary).toBe('timeout');
    expect(mockOpts.executeFn).toHaveBeenCalledTimes(1);
  });

  test('isEnabled returns false during retry — returns last error result', async () => {
    let callCount = 0;
    mockOpts.isEnabled.mockImplementation(() => {
      callCount++;
      return callCount <= 1;
    });

    const errorResult = makeErrorResult('socket hang up');
    mockOpts.executeFn.mockResolvedValueOnce(errorResult);

    const result = await executeSingleBotWithRetry(
      'bot1',
      botConfig,
      retryConfig,
      noopLogger,
      mockOpts
    );

    // lastResult exists from attempt 0, so it returns that instead of default skipped
    expect(result.status).toBe('error');
    expect(result.summary).toBe('socket hang up');
  });

  test('suppressSideEffects is true for intermediate retries', async () => {
    const errorResult = makeErrorResult('rate limit exceeded');
    const successResult = makeResult();

    mockOpts.executeFn
      .mockResolvedValueOnce(errorResult) // attempt 0
      .mockResolvedValueOnce(errorResult) // attempt 1 (intermediate)
      .mockResolvedValueOnce(successResult); // attempt 2 (last)

    await executeSingleBotWithRetry('bot1', botConfig, retryConfig, noopLogger, mockOpts);

    // Check the suppressSideEffects argument per call
    // attempt 0: suppressSideEffects = (0 < 2 && 0 > 0) = false
    expect(mockOpts.executeFn.mock.calls[0][2]).toEqual({ suppressSideEffects: false });
    // attempt 1: suppressSideEffects = (1 < 2 && 1 > 0) = true
    expect(mockOpts.executeFn.mock.calls[1][2]).toEqual({ suppressSideEffects: true });
    // attempt 2: suppressSideEffects = (2 < 2 && 2 > 0) = false
    expect(mockOpts.executeFn.mock.calls[2][2]).toEqual({ suppressSideEffects: false });
  });

  test('schedule updates on each retry attempt', async () => {
    const errorResult = makeErrorResult('fetch failed');
    mockOpts.executeFn.mockResolvedValue(errorResult);

    await executeSingleBotWithRetry('bot1', botConfig, retryConfig, noopLogger, mockOpts);

    // After exhaustion: retryCount = maxRetries
    expect(schedule.retryCount).toBe(2);
    expect(schedule.lastErrorMessage).toBe('fetch failed');
  });

  test('works when getSchedule returns undefined', async () => {
    mockOpts.getSchedule.mockReturnValue(undefined);
    const successResult = makeResult();
    mockOpts.executeFn.mockResolvedValueOnce(successResult);

    const result = await executeSingleBotWithRetry(
      'bot1',
      botConfig,
      retryConfig,
      noopLogger,
      mockOpts
    );

    expect(result.status).toBe('completed');
    // No crash when schedule is undefined
  });

  test('recovery on second retry resets schedule', async () => {
    const errorResult = makeErrorResult('ECONNREFUSED 127.0.0.1');
    const successResult = makeResult();

    mockOpts.executeFn
      .mockResolvedValueOnce(errorResult) // attempt 0
      .mockResolvedValueOnce(errorResult) // attempt 1
      .mockResolvedValueOnce(successResult); // attempt 2

    const result = await executeSingleBotWithRetry(
      'bot1',
      botConfig,
      retryConfig,
      noopLogger,
      mockOpts
    );

    expect(result.status).toBe('completed');
    expect(result.retryAttempt).toBe(2);
    expect(schedule.retryCount).toBe(0);
    expect(schedule.lastErrorMessage).toBeNull();
  });

  test('maxRetries=0 means no retries on error', async () => {
    retryConfig.maxRetries = 0;
    const errorResult = makeErrorResult('timeout');
    mockOpts.executeFn.mockResolvedValueOnce(errorResult);

    const result = await executeSingleBotWithRetry(
      'bot1',
      botConfig,
      retryConfig,
      noopLogger,
      mockOpts
    );

    expect(result.status).toBe('error');
    expect(mockOpts.executeFn).toHaveBeenCalledTimes(1);
    expect(mockOpts.sleepFn).not.toHaveBeenCalled();
    expect(result.retryAttempt).toBe(0);
  });

  test('bot stopped before any attempt — returns default skipped result', async () => {
    mockOpts.isBotRunning.mockReturnValue(false);

    const result = await executeSingleBotWithRetry(
      'bot1',
      botConfig,
      retryConfig,
      noopLogger,
      mockOpts
    );

    expect(result.status).toBe('skipped');
    expect(result.summary).toBe('Bot stopped during retry');
    expect(result.durationMs).toBe(0);
    expect(mockOpts.executeFn).not.toHaveBeenCalled();
  });
});

import { describe, expect, mock, test } from 'bun:test';
import {
  BackendCircuitBreaker,
  type CircuitBreakerConfig,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  executeSingleBotWithRetry,
  isWeeklyQuotaError,
} from '../src/bot/agent-retry-engine';
import { GlobalAgentLoopConfigSchema } from '../src/config';

const QUOTA_ERR = new Error(
  'Failed to generate response: Error: Ollama API error: 429 Too Many Requests'
);
const WEEKLY_ERR = new Error(
  'Ollama API error: 429 Too Many Requests — you have reached your weekly usage limit'
);

function makeBreaker(
  overrides: Partial<CircuitBreakerConfig> = {},
  start = 1_000_000
): { breaker: BackendCircuitBreaker; clock: { now: number } } {
  const clock = { now: start };
  const breaker = new BackendCircuitBreaker(
    { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...overrides },
    () => clock.now
  );
  return { breaker, clock };
}

function mockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  } as any;
}

describe('agentLoop.circuitBreaker config', () => {
  test('defaults: enabled, threshold 3, 30 min cooldown, 6 h weekly-quota cooldown', () => {
    const parsed = GlobalAgentLoopConfigSchema.parse({});
    expect(parsed.circuitBreaker).toEqual({
      enabled: true,
      threshold: 3,
      cooldownMs: 30 * 60_000,
      weeklyQuotaCooldownMs: 6 * 3_600_000,
    });
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG).toEqual(parsed.circuitBreaker);
  });

  test('accepts overrides', () => {
    const parsed = GlobalAgentLoopConfigSchema.parse({
      circuitBreaker: { threshold: 1, cooldownMs: 1000, weeklyQuotaCooldownMs: 2000 },
    });
    expect(parsed.circuitBreaker.threshold).toBe(1);
    expect(parsed.circuitBreaker.cooldownMs).toBe(1000);
    expect(parsed.circuitBreaker.weeklyQuotaCooldownMs).toBe(2000);
  });
});

describe('isWeeklyQuotaError', () => {
  test('matches the Ollama weekly usage limit text case-insensitively', () => {
    expect(isWeeklyQuotaError(WEEKLY_ERR)).toBe(true);
    expect(isWeeklyQuotaError('Weekly Usage Limit reached')).toBe(true);
  });

  test('does not match a plain 429', () => {
    expect(isWeeklyQuotaError(QUOTA_ERR)).toBe(false);
    expect(isWeeklyQuotaError(undefined)).toBe(false);
  });
});

describe('BackendCircuitBreaker', () => {
  test('starts closed with empty state', () => {
    const { breaker } = makeBreaker();
    expect(breaker.shouldSkip('ollama')).toEqual({ skip: false, until: null, probe: false });
    expect(breaker.getState()).toEqual({});
  });

  test('opens after `threshold` consecutive CONTEXTUAL failures, not before', () => {
    const { breaker, clock } = makeBreaker({ threshold: 3 });
    breaker.recordFailure('ollama', QUOTA_ERR);
    breaker.recordFailure('ollama', QUOTA_ERR);
    expect(breaker.shouldSkip('ollama').skip).toBe(false);
    expect(breaker.getState().ollama.consecutiveFailures).toBe(2);

    const state = breaker.recordFailure('ollama', QUOTA_ERR);
    expect(state.open).toBe(true);
    expect(state.until).toBe(clock.now + DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs);
    expect(state.lastError).toContain('429');
    expect(breaker.shouldSkip('ollama')).toEqual({ skip: true, until: state.until, probe: false });
  });

  test('is tracked per backend (fleet-wide per backend, independent across backends)', () => {
    const { breaker } = makeBreaker({ threshold: 1 });
    breaker.recordFailure('ollama', QUOTA_ERR);
    expect(breaker.shouldSkip('ollama').skip).toBe(true);
    expect(breaker.shouldSkip('claude-cli').skip).toBe(false);
  });

  test('non-CONTEXTUAL failures do not count and reset the consecutive run', () => {
    const { breaker } = makeBreaker({ threshold: 2 });
    breaker.recordFailure('ollama', QUOTA_ERR);
    breaker.recordFailure('ollama', new Error('fetch failed: ECONNRESET'));
    breaker.recordFailure('ollama', QUOTA_ERR);
    expect(breaker.shouldSkip('ollama').skip).toBe(false);
    expect(breaker.getState().ollama.consecutiveFailures).toBe(1);
  });

  test('"weekly usage limit" uses the long weeklyQuotaCooldownMs', () => {
    const { breaker, clock } = makeBreaker({ threshold: 1 });
    const state = breaker.recordFailure('ollama', WEEKLY_ERR);
    expect(state.open).toBe(true);
    expect(state.until).toBe(clock.now + DEFAULT_CIRCUIT_BREAKER_CONFIG.weeklyQuotaCooldownMs);
  });

  test('a success closes the circuit and resets the counter', () => {
    const { breaker } = makeBreaker({ threshold: 1 });
    breaker.recordFailure('ollama', QUOTA_ERR);
    expect(breaker.shouldSkip('ollama').skip).toBe(true);
    breaker.recordSuccess('ollama');
    const s = breaker.getState().ollama;
    expect(s.open).toBe(false);
    expect(s.until).toBeNull();
    expect(s.consecutiveFailures).toBe(0);
    expect(breaker.shouldSkip('ollama').skip).toBe(false);
  });

  test('half-open: after the cooldown exactly one probe passes, others keep skipping', () => {
    const { breaker, clock } = makeBreaker({ threshold: 1, cooldownMs: 10_000 });
    breaker.recordFailure('ollama', QUOTA_ERR);
    clock.now += 10_001;

    const first = breaker.shouldSkip('ollama');
    expect(first.skip).toBe(false);
    expect(first.probe).toBe(true);
    expect(breaker.getState().ollama.halfOpen).toBe(true);

    // A second bot arriving while the probe is in flight is still held back
    const second = breaker.shouldSkip('ollama');
    expect(second.skip).toBe(true);
    expect(second.probe).toBe(false);
  });

  test('half-open probe success closes; probe failure re-opens for a fresh cooldown', () => {
    const { breaker, clock } = makeBreaker({ threshold: 1, cooldownMs: 10_000 });
    breaker.recordFailure('ollama', QUOTA_ERR);
    clock.now += 10_001;
    expect(breaker.shouldSkip('ollama').probe).toBe(true);
    breaker.recordSuccess('ollama');
    expect(breaker.shouldSkip('ollama')).toEqual({ skip: false, until: null, probe: false });

    breaker.recordFailure('ollama', QUOTA_ERR);
    clock.now += 10_001;
    expect(breaker.shouldSkip('ollama').probe).toBe(true);
    const reopened = breaker.recordFailure('ollama', QUOTA_ERR);
    expect(reopened.open).toBe(true);
    expect(reopened.halfOpen).toBe(false);
    expect(reopened.until).toBe(clock.now + 10_000);
    expect(breaker.shouldSkip('ollama').skip).toBe(true);
  });

  test('a probe that never reports expires so the backend is not locked out forever', () => {
    const { breaker, clock } = makeBreaker({ threshold: 1, cooldownMs: 10_000 });
    breaker.recordFailure('ollama', QUOTA_ERR);
    clock.now += 10_001;
    expect(breaker.shouldSkip('ollama').probe).toBe(true);
    expect(breaker.shouldSkip('ollama').skip).toBe(true);
    clock.now += BackendCircuitBreaker.PROBE_TTL_MS + 1;
    expect(breaker.shouldSkip('ollama').probe).toBe(true);
  });

  test('disabled breaker never opens', () => {
    const { breaker } = makeBreaker({ enabled: false, threshold: 1 });
    const state = breaker.recordFailure('ollama', WEEKLY_ERR);
    expect(state.open).toBe(false);
    expect(breaker.shouldSkip('ollama').skip).toBe(false);
  });

  test('getState exposes the dashboard shape', () => {
    const { breaker, clock } = makeBreaker({ threshold: 1 });
    breaker.recordFailure('ollama', QUOTA_ERR);
    expect(breaker.getState()).toEqual({
      ollama: {
        open: true,
        halfOpen: false,
        until: clock.now + DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs,
        consecutiveFailures: 1,
        lastError: QUOTA_ERR.message,
      },
    });
  });
});

describe('executeSingleBotWithRetry + circuit breaker', () => {
  const botConfig = { id: 'b1', name: 'B1' } as any;
  const retryConfig = {
    maxRetries: 2,
    initialDelayMs: 1000,
    maxDelayMs: 1000,
    backoffMultiplier: 1,
  };

  function errorResult(summary: string) {
    return {
      botId: 'b1',
      botName: 'B1',
      status: 'error' as const,
      summary,
      durationMs: 1,
      plannerReasoning: '',
      plan: [],
      toolCalls: [],
      strategistRan: false,
      originalError: new Error(summary),
    };
  }

  test('stops retrying as soon as the circuit opens (no 3x attempts)', async () => {
    const executeFn = mock(() => Promise.resolve(errorResult(QUOTA_ERR.message)));
    const sleepFn = mock(() => Promise.resolve());
    let open = false;
    const logger = mockLogger();

    const result = await executeSingleBotWithRetry('b1', botConfig, retryConfig, logger, {
      executeFn,
      getSchedule: () => ({ retryCount: 0, lastErrorMessage: null }),
      sleepFn,
      isEnabled: () => true,
      isBotRunning: () => true,
      isCircuitOpen: () => {
        // opens after the first failed attempt
        const wasOpen = open;
        open = true;
        return wasOpen || open;
      },
    });

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
    expect(result.status).toBe('error');
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('retries normally when the circuit stays closed', async () => {
    const executeFn = mock(() => Promise.resolve(errorResult('fetch failed')));
    const sleepFn = mock(() => Promise.resolve());

    await executeSingleBotWithRetry('b1', botConfig, retryConfig, mockLogger(), {
      executeFn,
      getSchedule: () => undefined,
      sleepFn,
      isEnabled: () => true,
      isBotRunning: () => true,
      isCircuitOpen: () => false,
    });

    expect(executeFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });
});

describe('BackendCircuitBreaker — resetsAt-driven cooldown', () => {
  /** A rate-limit error that also carries the provider's own reset instant. */
  function quotaErrWithReset(resetsAt: Date): Error {
    return Object.assign(new Error('Claude CLI exited with code 1: session limit'), {
      apiErrorStatus: 429,
      resetsAt,
    });
  }

  test('uses the error resetsAt instead of the fixed cooldown when present', () => {
    const { breaker, clock } = makeBreaker({ threshold: 3 });
    const resetsAt = new Date(clock.now + 5 * 60_000);

    breaker.recordFailure('claude-cli', quotaErrWithReset(resetsAt));
    breaker.recordFailure('claude-cli', quotaErrWithReset(resetsAt));
    const state = breaker.recordFailure('claude-cli', quotaErrWithReset(resetsAt));

    expect(state.open).toBe(true);
    expect(state.until).toBe(resetsAt.getTime());
    // and NOT the default 30 min cooldown
    expect(state.until).not.toBe(clock.now + DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs);
  });

  test('clamps a resetsAt already in the past up to a one-minute floor', () => {
    const { breaker, clock } = makeBreaker({ threshold: 1 });
    const state = breaker.recordFailure(
      'claude-cli',
      quotaErrWithReset(new Date(clock.now - 60_000))
    );
    expect(state.until).toBe(clock.now + 60_000);
  });

  test('clamps a far-future resetsAt down to weeklyQuotaCooldownMs', () => {
    const { breaker, clock } = makeBreaker({ threshold: 1 });
    const state = breaker.recordFailure(
      'claude-cli',
      quotaErrWithReset(new Date(clock.now + 30 * 24 * 3_600_000))
    );
    expect(state.until).toBe(clock.now + DEFAULT_CIRCUIT_BREAKER_CONFIG.weeklyQuotaCooldownMs);
  });

  test('falls back to the fixed cooldown when the error carries no resetsAt', () => {
    const { breaker, clock } = makeBreaker({ threshold: 1 });
    const state = breaker.recordFailure('claude-cli', QUOTA_ERR);
    expect(state.until).toBe(clock.now + DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs);
  });

  test('a claude-cli session limit now opens the circuit at all (it used to read PERMANENT)', () => {
    const { breaker } = makeBreaker({ threshold: 3 });
    const blob =
      '{"is_error":true,"terminal_reason":"api_error","api_error_status":429,' +
      '"result":"You\'ve hit your session limit","permission_denials":[],"type":"result"}';
    const err = new Error(`Claude CLI exited with code 1: ${blob}`);

    breaker.recordFailure('claude-cli', err);
    breaker.recordFailure('claude-cli', err);
    const state = breaker.recordFailure('claude-cli', err);

    expect(state.open).toBe(true);
    expect(breaker.isOpen('claude-cli')).toBe(true);
  });
});

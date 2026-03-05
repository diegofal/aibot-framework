import type { AgentLoopRetryConfig, BotConfig } from '../config';
import type { Logger } from '../logger';
import type { AgentLoopResult } from './agent-loop';

/** Classification types for errors — determines retry strategy */
export type ErrorClassification = 'TRANSIENT' | 'PERMANENT' | 'CONTEXTUAL' | 'UNKNOWN';

export interface ClassifiedError {
  type: ErrorClassification;
  code?: string;
  message: string;
}

/** TRANSIENT: retry with normal exponential backoff (network, timeouts, server errors) */
const TRANSIENT_PATTERNS = [
  'timed out',
  'timeout',
  'etimedout',
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
  'socket hang up',
  'network',
  'fetch failed',
  'abort',
  '502',
  '503',
  '504',
  'und_err_headers_timeout',
  'und_err_body_timeout',
  'temporary failure',
];

/** PERMANENT: never retry (auth, permission, config errors) */
const PERMANENT_PATTERNS = [
  'auth',
  'permission',
  'forbidden',
  '401',
  '403',
  'invalid api key',
  'invalid_api_key',
  'not found config',
  'invalid config',
  'missing credentials',
];

/** CONTEXTUAL: retry with special handling (rate limits, quotas) */
const CONTEXTUAL_PATTERNS = ['rate limit', '429', 'quota', 'too many requests', 'throttl'];

/**
 * Classify an error into one of 4 types to determine retry strategy.
 * Inspired by OpenClaw's error classification pattern.
 *
 * - TRANSIENT: network/timeouts → retry with normal backoff
 * - PERMANENT: auth/permission → never retry
 * - CONTEXTUAL: rate limits/quotas → retry with special delay
 * - UNKNOWN: unclassified → conservative retry
 */
export function classifyError(error: unknown): ClassifiedError {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const originalMsg = error instanceof Error ? error.message : String(error);

  // PERMANENT first — never retry these
  for (const pattern of PERMANENT_PATTERNS) {
    if (msg.includes(pattern)) {
      return { type: 'PERMANENT', message: originalMsg };
    }
  }

  // CONTEXTUAL — rate limits need special handling
  for (const pattern of CONTEXTUAL_PATTERNS) {
    if (msg.includes(pattern)) {
      return { type: 'CONTEXTUAL', code: '429', message: originalMsg };
    }
  }

  // TRANSIENT — normal retry with backoff
  for (const pattern of TRANSIENT_PATTERNS) {
    if (msg.includes(pattern)) {
      return { type: 'TRANSIENT', message: originalMsg };
    }
  }

  // UNKNOWN — fallback, retry conservatively
  return { type: 'UNKNOWN', message: originalMsg };
}

/**
 * Legacy wrapper for backwards compatibility.
 * @deprecated Use classifyError() for detailed classification
 */
export function isRetryableError(error: unknown): boolean {
  const classified = classifyError(error);
  return classified.type !== 'PERMANENT';
}

/** Compute retry delay with exponential backoff and ±20% jitter */
export function computeRetryDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  multiplier: number
): number {
  const baseDelay = Math.min(initialDelayMs * multiplier ** attempt, maxDelayMs);
  const jitter = baseDelay * 0.2 * (2 * Math.random() - 1);
  return Math.max(0, Math.round(baseDelay + jitter));
}

/** Merge global retry defaults with per-bot overrides */
export function resolveRetryConfig(
  globalRetry: AgentLoopRetryConfig,
  botConfig: BotConfig
): AgentLoopRetryConfig {
  const botOverride = botConfig.agentLoop?.retry;
  if (!botOverride) return globalRetry;
  return {
    maxRetries: botOverride.maxRetries ?? globalRetry.maxRetries,
    initialDelayMs: botOverride.initialDelayMs ?? globalRetry.initialDelayMs,
    maxDelayMs: botOverride.maxDelayMs ?? globalRetry.maxDelayMs,
    backoffMultiplier: botOverride.backoffMultiplier ?? globalRetry.backoffMultiplier,
  };
}

export interface RetryEngineOpts {
  /** Execute a single bot cycle (may be suppressed on intermediate retries) */
  executeFn: (
    botId: string,
    botConfig: BotConfig,
    opts?: { suppressSideEffects?: boolean }
  ) => Promise<AgentLoopResult>;
  /** Look up the schedule entry for retry tracking */
  getSchedule: (
    botId: string
  ) => { retryCount: number; lastErrorMessage: string | null } | undefined;
  /** Interruptible sleep */
  sleepFn: (ms: number) => Promise<void>;
  /** Is the loop still running? */
  isEnabled: () => boolean;
  /** Is this bot still active? */
  isBotRunning: (botId: string) => boolean;
}

/**
 * Retry wrapper around a single-bot execution.
 * Handles transient error classification, exponential backoff, and schedule tracking.
 */
export async function executeSingleBotWithRetry(
  botId: string,
  botConfig: BotConfig,
  retryConfig: AgentLoopRetryConfig,
  botLogger: Logger,
  opts: RetryEngineOpts
): Promise<AgentLoopResult> {
  const { executeFn, getSchedule, sleepFn, isEnabled, isBotRunning } = opts;
  const schedule = getSchedule(botId);

  let lastResult: AgentLoopResult | undefined;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    if (!isEnabled() || !isBotRunning(botId)) {
      return (
        lastResult ?? {
          botId,
          botName: botConfig.name,
          status: 'skipped',
          summary: 'Bot stopped during retry',
          durationMs: 0,
          plannerReasoning: '',
          plan: [],
          toolCalls: [],
          strategistRan: false,
        }
      );
    }

    const suppressSideEffects = attempt < retryConfig.maxRetries && attempt > 0;
    lastResult = await executeFn(botId, botConfig, { suppressSideEffects });

    if (lastResult.status !== 'error') {
      if (attempt > 0) {
        botLogger.info({ botId, attempt }, `Agent loop: recovered after ${attempt} retry(s)`);
        lastResult.retryAttempt = attempt;
      }
      if (schedule) {
        schedule.retryCount = 0;
        schedule.lastErrorMessage = null;
      }
      return lastResult;
    }

    const classified = classifyError(lastResult.summary);

    if (classified.type === 'PERMANENT') {
      botLogger.warn(
        { botId, errorType: classified.type, error: lastResult.summary },
        'Agent loop: permanent error (auth/permission/config), skipping retry'
      );
      if (schedule) {
        schedule.retryCount = 0;
        schedule.lastErrorMessage = lastResult.summary;
      }
      return lastResult;
    }

    if (attempt < retryConfig.maxRetries) {
      // CONTEXTUAL errors get longer initial delay (rate limit window)
      let delayMs = computeRetryDelay(
        attempt,
        retryConfig.initialDelayMs,
        retryConfig.maxDelayMs,
        retryConfig.backoffMultiplier
      );

      if (classified.type === 'CONTEXTUAL') {
        // Rate limits: start with 2x delay, cap at 60s
        delayMs = Math.min(delayMs * 2, 60000);
      }

      botLogger.warn(
        {
          botId,
          attempt: attempt + 1,
          maxRetries: retryConfig.maxRetries,
          errorType: classified.type,
          delayMs,
          error: lastResult.summary,
        },
        `Agent loop: ${classified.type.toLowerCase()} error, retrying in ${Math.round(delayMs / 1000)}s`
      );
      if (schedule) {
        schedule.retryCount = attempt + 1;
        schedule.lastErrorMessage = lastResult.summary;
      }
      await sleepFn(delayMs);
    }
  }

  botLogger.error(
    { botId, attempts: retryConfig.maxRetries + 1 },
    'Agent loop: all retries exhausted'
  );
  if (schedule) {
    schedule.retryCount = retryConfig.maxRetries;
    schedule.lastErrorMessage = lastResult?.summary ?? null;
  }
  if (lastResult) lastResult.retryAttempt = retryConfig.maxRetries;
  return lastResult as AgentLoopResult;
}

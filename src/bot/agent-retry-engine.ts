import type { AgentLoopRetryConfig, BotConfig } from '../config';
import type { Logger } from '../logger';
import type { AgentLoopResult } from './agent-loop';

/** Patterns that indicate transient errors worth retrying (all lowercase) */
const RETRYABLE_PATTERNS = [
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
  'rate limit',
  '429',
  '502',
  '503',
  '504',
];

/** Patterns that indicate permanent errors — never retry (all lowercase) */
const NON_RETRYABLE_PATTERNS = [
  'auth',
  'permission',
  'forbidden',
  '401',
  '403',
  'invalid api key',
  'invalid_api_key',
  'not found config',
];

/** Classify whether an error is worth retrying (timeout, network) vs permanent (auth, permission) */
export function isRetryableError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (msg.includes(pattern)) return false;
  }
  for (const pattern of RETRYABLE_PATTERNS) {
    if (msg.includes(pattern)) return true;
  }
  return false;
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

    if (!isRetryableError(lastResult.summary)) {
      botLogger.warn(
        { botId, error: lastResult.summary },
        'Agent loop: non-retryable error, skipping retry'
      );
      if (schedule) {
        schedule.retryCount = 0;
        schedule.lastErrorMessage = lastResult.summary;
      }
      return lastResult;
    }

    if (attempt < retryConfig.maxRetries) {
      const delayMs = computeRetryDelay(
        attempt,
        retryConfig.initialDelayMs,
        retryConfig.maxDelayMs,
        retryConfig.backoffMultiplier
      );
      botLogger.warn(
        {
          botId,
          attempt: attempt + 1,
          maxRetries: retryConfig.maxRetries,
          delayMs,
          error: lastResult.summary,
        },
        `Agent loop: retryable error, retrying in ${Math.round(delayMs / 1000)}s`
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
  return lastResult!;
}

import type { AgentLoopRetryConfig, BotConfig } from '../config';
import type { Logger } from '../logger';
import type { AgentLoopResult } from './agent-loop';
import { type FailoverReason, classifyFailoverReason } from './model-failover/failover-error';

/** Classification types for errors — determines retry strategy */
export type ErrorClassification = 'TRANSIENT' | 'PERMANENT' | 'CONTEXTUAL' | 'UNKNOWN';

export interface ClassifiedError {
  type: ErrorClassification;
  code?: string;
  message: string;
  /** Structured failover reason when classified from an error object */
  failoverReason?: FailoverReason;
  /**
   * Absolute instant the provider says the limit lifts (Claude CLI's
   * `resets 12:20pm (…)` hint). Used by the circuit breaker in place of the
   * fixed cooldown.
   */
  resetsAt?: Date;
}

/**
 * Pattern lists are word-anchored regexes, not bare substrings.
 *
 * A raw `--output-format json` blob from the Claude CLI contains keys such as
 * `"permission_denials"` and `"api_error_status"`. Under substring matching
 * those keys made a 429 rate limit look like a permanent auth failure — the
 * cycle was never retried and the circuit breaker never opened. Anchoring on
 * word boundaries (`_` counts as a word character, so `permission_denials`
 * cannot match `\bpermission\b`) plus stripping JSON keys before matching
 * keeps a key from ever deciding the class.
 */

/** TRANSIENT: retry with normal exponential backoff (network, timeouts, server errors) */
const TRANSIENT_PATTERNS: RegExp[] = [
  /timed\s*out/i,
  /\btimeout/i,
  /\betimedout\b/i,
  /\beconnreset\b/i,
  /\beconnrefused\b/i,
  /\benotfound\b/i,
  /\beai_again\b/i,
  /socket hang up/i,
  /\bnetwork/i,
  /fetch failed/i,
  /\babort/i,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /\bund_err_headers_timeout\b/i,
  /\bund_err_body_timeout\b/i,
  /temporary failure/i,
];

/** PERMANENT: never retry (auth, permission, config errors) */
const PERMANENT_PATTERNS: RegExp[] = [
  /\bauth(?:entication|orization|orized|orised)?\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bpermissions?\b/i,
  /\bforbidden\b/i,
  /\b401\b/,
  /\b403\b/,
  /invalid[\s_-]?api[\s_-]?key/i,
  /not found config/i,
  /invalid config/i,
  /missing credentials/i,
];

/** CONTEXTUAL: retry with special handling (rate limits, quotas) */
const CONTEXTUAL_PATTERNS: RegExp[] = [
  /rate[\s_-]?limit/i,
  /\b429\b/,
  /\bquota/i,
  /too many requests/i,
  /\bthrottl/i,
];

/** `"some_key":` — a JSON key never describes what went wrong. */
const JSON_KEY_PATTERN = /"[A-Za-z_][A-Za-z0-9_]*"\s*:/g;

/** Strip JSON keys so only values and prose reach the pattern matchers. */
function stripJsonKeys(message: string): string {
  return message.replace(JSON_KEY_PATTERN, ' ');
}

/** Structured signals an error may carry (ClaudeCliError and look-alikes). */
interface StructuredErrorSignals {
  apiErrorStatus?: number;
  resetsAt?: Date;
}

function readStructuredSignals(error: unknown): StructuredErrorSignals {
  if (error == null || typeof error !== 'object') return {};
  const e = error as Record<string, unknown>;
  const signals: StructuredErrorSignals = {};

  const status = e.apiErrorStatus;
  if (typeof status === 'number' && Number.isFinite(status)) signals.apiErrorStatus = status;

  const resets = e.resetsAt;
  if (resets instanceof Date && !Number.isNaN(resets.getTime())) signals.resetsAt = resets;
  else if (typeof resets === 'string') {
    const parsed = new Date(resets);
    if (!Number.isNaN(parsed.getTime())) signals.resetsAt = parsed;
  }

  return signals;
}

/**
 * Classify an error into one of 4 types to determine retry strategy.
 * Inspired by OpenClaw's error classification pattern.
 *
 * - TRANSIENT: network/timeouts → retry with normal backoff
 * - PERMANENT: auth/permission → never retry
 * - CONTEXTUAL: rate limits/quotas → retry with special delay
 * - UNKNOWN: unclassified → conservative retry
 */
/** Map FailoverReason → ErrorClassification */
const FAILOVER_TO_CLASSIFICATION: Record<FailoverReason, ErrorClassification | null> = {
  auth: 'PERMANENT',
  billing: 'PERMANENT',
  context_length: 'PERMANENT',
  format: 'PERMANENT',
  rate_limit: 'CONTEXTUAL',
  timeout: 'TRANSIENT',
  unknown: null, // fall through to string patterns
};

export function classifyError(error: unknown): ClassifiedError {
  const signals = readStructuredSignals(error);
  const classified = classifyErrorCore(error, signals);
  if (signals.resetsAt && !classified.resetsAt) classified.resetsAt = signals.resetsAt;
  return classified;
}

function classifyErrorCore(error: unknown, signals: StructuredErrorSignals): ClassifiedError {
  // 0. Structured status from the backend itself (ClaudeCliError.apiErrorStatus)
  //    outranks every textual heuristic: the CLI told us exactly what happened.
  if (signals.apiErrorStatus != null) {
    const status = signals.apiErrorStatus;
    const message = error instanceof Error ? error.message : String(error);
    if (status === 429) {
      return {
        type: 'CONTEXTUAL',
        code: '429',
        message,
        failoverReason: 'rate_limit',
        resetsAt: signals.resetsAt,
      };
    }
    if (status === 401 || status === 403) {
      return { type: 'PERMANENT', code: String(status), message, failoverReason: 'auth' };
    }
    if (status >= 500 && status < 600) {
      return { type: 'TRANSIENT', code: String(status), message, failoverReason: 'timeout' };
    }
    // Anything else: fall through to the heuristics below.
  }

  // 1. Try structured classification for non-string values that carry
  //    status codes or error codes (the high-confidence signals).
  //    Only trust the failover classifier when it found structural data —
  //    message-only matches are handled below with the right priority order.
  if (error != null && typeof error !== 'string') {
    const failover = classifyFailoverReason(error);
    if (failover && failover.statusCode != null) {
      const mapped = FAILOVER_TO_CLASSIFICATION[failover.reason];
      if (mapped) {
        return {
          type: mapped,
          code: failover.statusCode.toString(),
          message: failover.message,
          failoverReason: failover.reason,
        };
      }
    }
    // Also trust error-code based classification (Node network errors)
    if (failover && !failover.statusCode) {
      const e = error as Record<string, unknown>;
      const hasErrorCode =
        typeof e.code === 'string' ||
        (e.cause && typeof e.cause === 'object' && typeof (e.cause as any).code === 'string');
      if (hasErrorCode) {
        const mapped = FAILOVER_TO_CLASSIFICATION[failover.reason];
        if (mapped) {
          return {
            type: mapped,
            code: String(e.code ?? (e.cause as any)?.code),
            message: failover.message,
            failoverReason: failover.reason,
          };
        }
      }
    }
  }

  // 2. Fall back to pattern matching over the message, with JSON keys removed
  //    so an embedded blob's field names cannot decide the classification.
  const originalMsg = error instanceof Error ? error.message : String(error);
  const haystack = stripJsonKeys(originalMsg);

  // PERMANENT first — never retry these
  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(haystack)) {
      return { type: 'PERMANENT', message: originalMsg };
    }
  }

  // CONTEXTUAL — rate limits need special handling
  for (const pattern of CONTEXTUAL_PATTERNS) {
    if (pattern.test(haystack)) {
      return { type: 'CONTEXTUAL', code: '429', message: originalMsg };
    }
  }

  // TRANSIENT — normal retry with backoff
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(haystack)) {
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

// ── Backend circuit breaker ──

export interface CircuitBreakerConfig {
  enabled: boolean;
  /** Consecutive CONTEXTUAL failures on one backend before the circuit opens */
  threshold: number;
  /** Cooldown for an ordinary 429 / rate limit */
  cooldownMs: number;
  /** Cooldown when the error text mentions a weekly usage limit (shared cloud quota) */
  weeklyQuotaCooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  threshold: 3,
  cooldownMs: 30 * 60_000,
  weeklyQuotaCooldownMs: 6 * 3_600_000,
};

export interface BackendCircuitState {
  open: boolean;
  /** A probe is in flight after the cooldown; other callers keep skipping until it reports */
  halfOpen: boolean;
  /** Epoch ms when the cooldown ends; null while closed */
  until: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface CircuitSkipDecision {
  skip: boolean;
  until: number | null;
  /** True when this caller was granted the single half-open probe */
  probe: boolean;
}

const WEEKLY_QUOTA_PATTERN = /weekly usage limit/i;

/** Does the error text name a weekly quota (Ollama Cloud's shared weekly allowance)? */
export function isWeeklyQuotaError(error: unknown): boolean {
  if (error == null) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return WEEKLY_QUOTA_PATTERN.test(msg);
}

interface CircuitEntry {
  consecutiveFailures: number;
  until: number | null;
  lastError: string | null;
  probeStartedAt: number | null;
}

/**
 * Fleet-wide circuit breaker keyed by LLM backend.
 *
 * A 429 on Ollama Cloud is a shared quota, so one bot's failure predicts every
 * other bot's: after `threshold` consecutive CONTEXTUAL failures the circuit
 * opens and `shouldSkip()` tells callers to sit the cycle out instead of
 * burning three retries each. Non-CONTEXTUAL failures break the consecutive
 * run (the backend answered, just not with a quota error) and a success
 * closes the circuit. After the cooldown exactly one caller is let through as
 * a half-open probe; its outcome closes or re-opens the circuit. A probe that
 * never reports expires after PROBE_TTL_MS so a crashed cycle cannot lock a
 * backend out forever.
 */
export class BackendCircuitBreaker {
  static readonly PROBE_TTL_MS = 10 * 60_000;
  /** Floor for a provider-supplied `resetsAt` cooldown. */
  static readonly MIN_RESET_COOLDOWN_MS = 60_000;

  private entries = new Map<string, CircuitEntry>();

  constructor(
    private config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
    private now: () => number = () => Date.now()
  ) {}

  private entry(backend: string): CircuitEntry {
    let e = this.entries.get(backend);
    if (!e) {
      e = { consecutiveFailures: 0, until: null, lastError: null, probeStartedAt: null };
      this.entries.set(backend, e);
    }
    return e;
  }

  private snapshot(e: CircuitEntry): BackendCircuitState {
    const now = this.now();
    const coolingDown = e.until !== null && now < e.until;
    const probing =
      e.probeStartedAt !== null && now - e.probeStartedAt <= BackendCircuitBreaker.PROBE_TTL_MS;
    return {
      open: coolingDown || probing,
      halfOpen: !coolingDown && probing,
      until: e.until,
      consecutiveFailures: e.consecutiveFailures,
      lastError: e.lastError,
    };
  }

  /** Record a failed call. Returns the backend's state after the update. */
  recordFailure(backend: string, error: unknown): BackendCircuitState {
    const e = this.entry(backend);
    e.probeStartedAt = null;
    const classified = classifyError(error);
    e.lastError = classified.message;

    if (!this.config.enabled || classified.type !== 'CONTEXTUAL') {
      // The backend answered with something other than a quota error: the
      // consecutive run is broken and a half-open probe counts as recovered.
      e.consecutiveFailures = 0;
      e.until = null;
      return this.snapshot(e);
    }

    e.consecutiveFailures++;
    if (e.consecutiveFailures >= this.config.threshold) {
      e.until = this.now() + this.cooldownFor(error, classified);
    }
    return this.snapshot(e);
  }

  /**
   * How long to hold the circuit open.
   *
   * When the backend told us when the limit lifts (Claude CLI's
   * `resets 12:20pm (…)`) we honour that instant instead of the fixed
   * cooldown — clamped to [1 min, weeklyQuotaCooldownMs] so a bad clock or a
   * misparsed hint can neither hammer the backend nor lock it out for days.
   */
  private cooldownFor(error: unknown, classified: ClassifiedError): number {
    const cap = this.config.weeklyQuotaCooldownMs;
    if (classified.resetsAt) {
      const span = classified.resetsAt.getTime() - this.now();
      return Math.min(Math.max(span, BackendCircuitBreaker.MIN_RESET_COOLDOWN_MS), cap);
    }
    return isWeeklyQuotaError(error) ? cap : this.config.cooldownMs;
  }

  /** Record a successful call: closes the circuit and forgets past failures. */
  recordSuccess(backend: string): void {
    const e = this.entry(backend);
    e.consecutiveFailures = 0;
    e.until = null;
    e.probeStartedAt = null;
    e.lastError = null;
  }

  /** Should a caller on this backend skip its cycle? Grants the half-open probe. */
  shouldSkip(backend: string): CircuitSkipDecision {
    const e = this.entries.get(backend);
    if (!e) return { skip: false, until: null, probe: false };
    const now = this.now();

    if (e.until !== null && now < e.until) return { skip: true, until: e.until, probe: false };

    if (e.until !== null) {
      // Cooldown elapsed → half-open. One probe at a time.
      const probeActive =
        e.probeStartedAt !== null && now - e.probeStartedAt <= BackendCircuitBreaker.PROBE_TTL_MS;
      if (probeActive) return { skip: true, until: e.until, probe: false };
      e.probeStartedAt = now;
      return { skip: false, until: e.until, probe: true };
    }

    return { skip: false, until: null, probe: false };
  }

  isOpen(backend: string): boolean {
    const e = this.entries.get(backend);
    return e ? this.snapshot(e).open : false;
  }

  /** Dashboard view: every backend that has ever failed or been probed. */
  getState(): Record<string, BackendCircuitState> {
    const out: Record<string, BackendCircuitState> = {};
    for (const [backend, e] of this.entries) out[backend] = this.snapshot(e);
    return out;
  }
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
  /**
   * Has the bot's planner backend circuit opened? Checked after every failed
   * attempt so a quota outage stops the retry ladder at once instead of
   * spending the remaining attempts on a backend that cannot answer.
   */
  isCircuitOpen?: () => boolean;
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
  const { executeFn, getSchedule, sleepFn, isEnabled, isBotRunning, isCircuitOpen } = opts;
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

    const classified = classifyError(lastResult.originalError ?? lastResult.summary);

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

    if (isCircuitOpen?.()) {
      botLogger.info(
        { botId, attempt: attempt + 1, errorType: classified.type },
        'Agent loop: backend circuit opened, not retrying this cycle'
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

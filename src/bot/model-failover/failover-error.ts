/**
 * Failover Error Classification
 *
 * Transplanted from OpenClaw's failover-error.ts (240 LOC) and adapted
 * for aibot-framework's backend model (ollama + claude-cli).
 *
 * OpenClaw has 9 FailoverReasons. We consolidate to 7 — dropping
 * 'auth_permanent' and 'session_expired' which are auth-profile concerns
 * we don't have.
 *
 * Target: src/bot/model-failover/failover-error.ts
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why a model candidate failed.
 *
 * Each reason maps to a failover decision:
 *   auth         → skip all models on this backend
 *   billing      → skip backend, long cooldown
 *   rate_limit   → skip this model, try next candidate
 *   timeout      → skip this model, try next candidate
 *   context_length → abort entirely (bigger model won't help)
 *   format       → abort entirely (request is malformed)
 *   unknown      → try next if candidates remain
 */
export type FailoverReason =
  | 'auth'
  | 'billing'
  | 'rate_limit'
  | 'timeout'
  | 'context_length'
  | 'format'
  | 'unknown';

/**
 * A classified error ready for failover decisions.
 */
export class FailoverError extends Error {
  public readonly reason: FailoverReason;
  public readonly originalError: unknown;
  public readonly statusCode?: number;

  constructor(
    reason: FailoverReason,
    message: string,
    originalError: unknown,
    statusCode?: number
  ) {
    super(message);
    this.name = 'FailoverError';
    this.reason = reason;
    this.originalError = originalError;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Status code → reason mapping. Checked first (most reliable signal).
 */
const STATUS_MAP: Record<number, FailoverReason> = {
  400: 'format',
  401: 'auth',
  402: 'billing',
  403: 'auth',
  404: 'format', // model not found = effectively a format/config error
  408: 'timeout',
  429: 'rate_limit',
  502: 'timeout',
  503: 'timeout',
  504: 'timeout',
};

/**
 * Error code strings (from Node network errors) → reason.
 */
const ERROR_CODE_MAP: Record<string, FailoverReason> = {
  ETIMEDOUT: 'timeout',
  ECONNRESET: 'timeout',
  ECONNREFUSED: 'timeout', // e.g. Ollama not running
  ECONNABORTED: 'timeout',
  ENOTFOUND: 'timeout', // DNS failure
  EPIPE: 'timeout',
  EAI_AGAIN: 'timeout', // DNS temporary failure
  EHOSTUNREACH: 'timeout',
  ENETUNREACH: 'timeout',
  EHOSTDOWN: 'timeout', // host is down (OpenClaw failover pattern)
  ENETRESET: 'timeout', // connection reset by network (not peer)
  ESOCKETTIMEDOUT: 'timeout', // socket-level timeout (some HTTP libs)
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
  UND_ERR_HEADERS_TIMEOUT: 'timeout',
  UND_ERR_BODY_TIMEOUT: 'timeout',
};

/**
 * Regex patterns matched against error message. Last resort.
 * Order matters — first match wins.
 */
const MESSAGE_PATTERNS: Array<{ pattern: RegExp; reason: FailoverReason }> = [
  // Context / token limits
  { pattern: /context.{0,20}(length|limit|window|overflow)/i, reason: 'context_length' },
  { pattern: /too many tokens/i, reason: 'context_length' },
  { pattern: /maximum.{0,10}(context|token)/i, reason: 'context_length' },
  { pattern: /prompt (?:is )?too (long|large)/i, reason: 'context_length' },
  { pattern: /exceeded max context length/i, reason: 'context_length' },
  { pattern: /exceeds? .{0,20}(token|context) (limit|length)/i, reason: 'context_length' },

  // Rate limits (when no status code available)
  { pattern: /rate.{0,5}limit/i, reason: 'rate_limit' },
  { pattern: /too many requests/i, reason: 'rate_limit' },
  { pattern: /quota.{0,10}exceeded/i, reason: 'rate_limit' },
  { pattern: /resource.{0,10}exhausted/i, reason: 'rate_limit' },

  // Auth
  { pattern: /unauthorized/i, reason: 'auth' },
  { pattern: /forbidden/i, reason: 'auth' },
  { pattern: /invalid.{0,10}(api.?key|token|credential)/i, reason: 'auth' },
  { pattern: /authentication/i, reason: 'auth' },

  // Billing
  { pattern: /billing/i, reason: 'billing' },
  { pattern: /payment.{0,10}required/i, reason: 'billing' },
  { pattern: /insufficient.{0,10}(funds|credits|balance)/i, reason: 'billing' },

  // Timeout (when no error code available)
  { pattern: /timed?\s*out/i, reason: 'timeout' },
  { pattern: /deadline.{0,10}exceeded/i, reason: 'timeout' },
  { pattern: /ECONNREFUSED/i, reason: 'timeout' },
  { pattern: /network.{0,10}error/i, reason: 'timeout' },
  { pattern: /fetch failed/i, reason: 'timeout' },
];

/**
 * Attempt to classify an arbitrary error into a FailoverReason.
 *
 * Returns a FailoverError if classification succeeds, or null if the
 * error doesn't match any known pattern. Null means "let the error
 * pass through as-is" — the caller decides what to do.
 *
 * Classification priority:
 *   1. HTTP status code (most reliable)
 *   2. Error code string (Node-level)
 *   3. Message regex (last resort)
 *
 * Inspired by OpenClaw's coerceToFailoverError(), adapted for our
 * simpler backend surface (no OAuth, no provider-specific quirks).
 */
export function classifyFailoverReason(error: unknown): FailoverError | null {
  const statusCode = extractStatusCode(error);
  const errorCode = extractErrorCode(error);
  const message = extractMessage(error);

  // 1. Status code check
  if (statusCode && STATUS_MAP[statusCode]) {
    return new FailoverError(
      STATUS_MAP[statusCode],
      `HTTP ${statusCode}: ${message}`,
      error,
      statusCode
    );
  }

  // 2. Error code check
  if (errorCode && ERROR_CODE_MAP[errorCode]) {
    return new FailoverError(ERROR_CODE_MAP[errorCode], `${errorCode}: ${message}`, error);
  }

  // 3. Message pattern check
  for (const { pattern, reason } of MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return new FailoverError(reason, message, error, statusCode ?? undefined);
    }
  }

  // Unclassifiable
  return null;
}

/**
 * Determines whether a failover reason means we should skip all
 * remaining models on the same backend, not just the current model.
 *
 * Auth and billing are backend-scoped: if Ollama rejects our auth,
 * trying a different Ollama model won't help.
 */
export function isBackendScoped(reason: FailoverReason): boolean {
  return reason === 'auth' || reason === 'billing';
}

/**
 * Determines whether this error should abort the entire failover chain.
 * No point trying other models when the problem is the request itself.
 */
export function shouldAbortChain(reason: FailoverReason): boolean {
  return reason === 'context_length' || reason === 'format';
}

// ---------------------------------------------------------------------------
// Error field extractors
// ---------------------------------------------------------------------------

function extractStatusCode(error: unknown): number | null {
  if (error == null || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;

  // Direct status/statusCode property
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;

  // Nested in response object (fetch-style)
  if (e.response && typeof e.response === 'object') {
    const resp = e.response as Record<string, unknown>;
    if (typeof resp.status === 'number') return resp.status;
    if (typeof resp.statusCode === 'number') return resp.statusCode;
  }

  // Nested in cause (Node.js AggregateError)
  if (e.cause && typeof e.cause === 'object') {
    return extractStatusCode(e.cause);
  }

  return null;
}

function extractErrorCode(error: unknown): string | null {
  if (error == null || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;

  if (typeof e.code === 'string') return e.code;
  if (e.cause && typeof e.cause === 'object') {
    const cause = e.cause as Record<string, unknown>;
    if (typeof cause.code === 'string') return cause.code;
  }

  return null;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error != null && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
  }
  return String(error);
}

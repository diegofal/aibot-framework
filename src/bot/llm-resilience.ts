/**
 * LLM Resilience Module
 *
 * Provides retry logic, error classification, and circuit breaker patterns
 * for LLM calls. Inspired by patterns from Instructor (jxnl/instructor) and
 * Semantic Kernel's retry policies.
 */

import type { Logger } from '../logger';

/**
 * Categories of LLM errors for retry decisions.
 */
export type LLMErrorCategory =
  | 'transient'      // Retryable: timeouts, rate limits, temporary failures
  | 'permanent'      // Non-retryable: auth errors, invalid requests
  | 'context_length' // Non-retryable: prompt too large
  | 'unknown';       // Unknown, may retry with caution

/**
 * Structured error information from LLM calls.
 */
export interface LLMErrorInfo {
  category: LLMErrorCategory;
  message: string;
  originalError: unknown;
  retryable: boolean;
  suggestedAction?: string;
}

/**
 * Result of a resilient LLM call.
 */
export interface ResilientResult<T> {
  success: boolean;
  data?: T;
  error?: LLMErrorInfo;
  attempts: number;
  totalDurationMs: number;
}

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableStatuses?: number[]; // HTTP status codes to retry
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
};

/**
 * Circuit breaker states.
 */
type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker configuration.
 */
export interface CircuitBreakerConfig {
  failureThreshold: number;      // Failures before opening
  resetTimeoutMs: number;        // Time before half-open
  halfOpenMaxCalls: number;      // Calls allowed in half-open
}

/**
 * Default circuit breaker configuration.
 */
export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  halfOpenMaxCalls: 3,
};

/**
 * Circuit breaker for LLM calls.
 * Prevents cascading failures when LLM is down or rate-limited.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime?: number;
  private halfOpenCalls = 0;

  constructor(
    private config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
    private logger?: Logger,
  ) {}

  /**
   * Check if the circuit allows calls.
   */
  canExecute(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      const now = Date.now();
      if (this.lastFailureTime && now - this.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state = 'half-open';
        this.halfOpenCalls = 0;
        this.logger?.debug('Circuit breaker entering half-open state');
        return true;
      }
      return false;
    }

    // half-open
    return this.halfOpenCalls < this.config.halfOpenMaxCalls;
  }

  /**
   * Record a successful call.
   */
  recordSuccess(): void {
    this.failures = 0;
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.halfOpenCalls = 0;
      this.logger?.debug('Circuit breaker closed after success in half-open');
    }
  }

  /**
   * Record a failed call.
   */
  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.state = 'open';
      this.logger?.warn({ failures: this.failures }, 'Circuit breaker opened from half-open');
    } else if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      this.logger?.warn({ failures: this.failures }, 'Circuit breaker opened');
    }
  }

  /**
   * Get current circuit state.
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get failure count.
   */
  getFailureCount(): number {
    return this.failures;
  }
}

/**
 * Classify an error from an LLM call.
 */
export function classifyLLMError(error: unknown): LLMErrorInfo {
  // Handle Error objects
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Context length errors - never retry
    if (
      message.includes('context length') ||
      message.includes('too many tokens') ||
      message.includes('maximum context length') ||
      message.includes('token limit') ||
      message.includes('prompt is too long')
    ) {
      return {
        category: 'context_length',
        message: error.message,
        originalError: error,
        retryable: false,
        suggestedAction: 'Reduce prompt size or split into smaller requests',
      };
    }

    // Rate limiting - retry with backoff
    if (
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('429') ||
      message.includes('throttled')
    ) {
      return {
        category: 'transient',
        message: error.message,
        originalError: error,
        retryable: true,
        suggestedAction: 'Retry with exponential backoff',
      };
    }

    // Timeouts - retry
    if (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('etimedout') ||
      message.includes('econnreset')
    ) {
      return {
        category: 'transient',
        message: error.message,
        originalError: error,
        retryable: true,
        suggestedAction: 'Retry with increased timeout',
      };
    }

    // Connection errors - retry
    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('network error') ||
      message.includes('socket hang up') ||
      message.includes('fetch failed')
    ) {
      return {
        category: 'transient',
        message: error.message,
        originalError: error,
        retryable: true,
        suggestedAction: 'Retry with exponential backoff',
      };
    }

    // Auth errors - don't retry
    if (
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('invalid api key') ||
      message.includes('authentication') ||
      message.includes('401') ||
      message.includes('403')
    ) {
      return {
        category: 'permanent',
        message: error.message,
        originalError: error,
        retryable: false,
        suggestedAction: 'Check API credentials and permissions',
      };
    }

    // Bad request - don't retry
    if (
      message.includes('bad request') ||
      message.includes('invalid request') ||
      message.includes('400') ||
      message.includes('validation error')
    ) {
      return {
        category: 'permanent',
        message: error.message,
        originalError: error,
        retryable: false,
        suggestedAction: 'Fix request parameters',
      };
    }
  }

  // Check for HTTP response errors with status codes
  if (error && typeof error === 'object') {
    const status = (error as { status?: number }).status;
    if (typeof status === 'number') {
      if (status === 429 || status >= 500) {
        return {
          category: 'transient',
          message: `HTTP ${status} error`,
          originalError: error,
          retryable: true,
          suggestedAction: `Retry with backoff for status ${status}`,
        };
      }
      if (status >= 400 && status < 500) {
        return {
          category: 'permanent',
          message: `HTTP ${status} error`,
          originalError: error,
          retryable: false,
          suggestedAction: `Fix client request for status ${status}`,
        };
      }
    }
  }

  // Unknown errors - cautious retry
  return {
    category: 'unknown',
    message: error instanceof Error ? error.message : String(error),
    originalError: error,
    retryable: true,
    suggestedAction: 'Retry once, then fail',
  };
}

/**
 * Calculate delay for retry with exponential backoff and jitter.
 */
function calculateRetryDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 30% jitter
  const delay = Math.min(exponentialDelay + jitter, config.maxDelayMs);
  return Math.floor(delay);
}

/**
 * Sleep for a given duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an LLM call with retry logic and circuit breaker.
 */
export async function executeWithResilience<T>(
  operation: () => Promise<T>,
  operationName: string,
  options: {
    retryConfig?: Partial<RetryConfig>;
    circuitBreaker?: CircuitBreaker;
    logger?: Logger;
    onRetry?: (attempt: number, delayMs: number, error: LLMErrorInfo) => void;
  } = {},
): Promise<ResilientResult<T>> {
  const {
    retryConfig: customRetry = {},
    circuitBreaker,
    logger,
    onRetry,
  } = options;

  const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...customRetry };
  const startTime = Date.now();

  // Check circuit breaker
  if (circuitBreaker && !circuitBreaker.canExecute()) {
    const error: LLMErrorInfo = {
      category: 'transient',
      message: 'Circuit breaker is open - LLM calls temporarily disabled',
      originalError: new Error('Circuit breaker open'),
      retryable: false,
      suggestedAction: 'Wait for circuit to close before retrying',
    };
    return {
      success: false,
      error,
      attempts: 0,
      totalDurationMs: Date.now() - startTime,
    };
  }

  let lastError: LLMErrorInfo | undefined;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      logger?.debug({ attempt, operation: operationName }, 'LLM call attempt');
      const result = await operation();

      // Record success in circuit breaker
      circuitBreaker?.recordSuccess();

      return {
        success: true,
        data: result,
        attempts: attempt + 1,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error) {
      lastError = classifyLLMError(error);

      logger?.warn({
        attempt,
        category: lastError.category,
        retryable: lastError.retryable,
        message: lastError.message,
        operation: operationName,
      }, 'LLM call failed');

      // Don't retry permanent errors
      if (!lastError.retryable) {
        circuitBreaker?.recordFailure();
        return {
          success: false,
          error: lastError,
          attempts: attempt + 1,
          totalDurationMs: Date.now() - startTime,
        };
      }

      // Don't retry if this was the last attempt
      if (attempt >= retryConfig.maxRetries) {
        circuitBreaker?.recordFailure();
        return {
          success: false,
          error: lastError,
          attempts: attempt + 1,
          totalDurationMs: Date.now() - startTime,
        };
      }

      // Calculate and wait for retry delay
      const delayMs = calculateRetryDelay(attempt, retryConfig);
      onRetry?.(attempt + 1, delayMs, lastError);

      logger?.info({
        attempt,
        delayMs,
        nextAttempt: attempt + 2,
        operation: operationName,
      }, 'Retrying LLM call');

      await sleep(delayMs);
    }
  }

  // Should never reach here, but TypeScript needs it
  return {
    success: false,
    error: lastError ?? {
      category: 'unknown',
      message: 'Unknown error after retries exhausted',
      originalError: new Error('Retries exhausted'),
      retryable: false,
    },
    attempts: retryConfig.maxRetries + 1,
    totalDurationMs: Date.now() - startTime,
  };
}

/**
 * Create a user-friendly error message from LLM error info.
 */
export function formatLLMErrorForUser(error: LLMErrorInfo): string {
  switch (error.category) {
    case 'context_length':
      return '❌ The conversation is too long. Try starting a new session with /reset.';
    case 'transient':
      return '❌ The AI service is temporarily unavailable. Please try again in a moment.';
    case 'permanent':
      return '❌ There was a problem with the request. Please check your settings or contact support.';
    case 'unknown':
    default:
      return '❌ Failed to generate response. Please try again later.';
  }
}

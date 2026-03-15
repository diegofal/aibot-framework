import { describe, expect, test } from 'bun:test';
import {
  classifyFailoverReason,
  isBackendScoped,
  shouldAbortChain,
} from '../../../src/bot/model-failover/failover-error';

// ---------------------------------------------------------------------------
// classifyFailoverReason — status code extraction
// ---------------------------------------------------------------------------
describe('classifyFailoverReason — status codes', () => {
  test('direct status property', () => {
    const result = classifyFailoverReason({ status: 402, message: 'Payment required' });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('billing');
    expect(result?.statusCode).toBe(402);
  });

  test('direct statusCode property', () => {
    const result = classifyFailoverReason({ statusCode: 401, message: 'Unauthorized' });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('auth');
  });

  test('nested in response object (fetch-style)', () => {
    const result = classifyFailoverReason({
      response: { status: 429 },
      message: 'rate limited',
    });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('rate_limit');
  });

  test('nested in cause chain', () => {
    const result = classifyFailoverReason({
      message: 'wrapper error',
      cause: { status: 503, message: 'service unavailable' },
    });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('timeout');
    expect(result?.statusCode).toBe(503);
  });

  test.each([
    [400, 'format'],
    [401, 'auth'],
    [402, 'billing'],
    [403, 'auth'],
    [404, 'format'],
    [408, 'timeout'],
    [429, 'rate_limit'],
    [502, 'timeout'],
    [503, 'timeout'],
    [504, 'timeout'],
  ] as const)('status %d → %s', (status, expectedReason) => {
    const result = classifyFailoverReason({ status, message: 'test' });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe(expectedReason);
  });
});

// ---------------------------------------------------------------------------
// classifyFailoverReason — error code mapping
// ---------------------------------------------------------------------------
describe('classifyFailoverReason — error codes', () => {
  test.each([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ])('code %s → timeout', (code) => {
    const result = classifyFailoverReason({ code, message: 'network error' });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('timeout');
  });

  test('code in cause chain', () => {
    const result = classifyFailoverReason({
      message: 'connect failed',
      cause: { code: 'ECONNREFUSED' },
    });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// classifyFailoverReason — message pattern matching
// ---------------------------------------------------------------------------
describe('classifyFailoverReason — message patterns', () => {
  test('context length patterns', () => {
    expect(classifyFailoverReason(new Error('context length exceeded'))?.reason).toBe(
      'context_length'
    );
    expect(classifyFailoverReason(new Error('too many tokens'))?.reason).toBe('context_length');
    expect(classifyFailoverReason(new Error('prompt is too long'))?.reason).toBe('context_length');
  });

  test('rate limit patterns', () => {
    expect(classifyFailoverReason(new Error('rate limit reached'))?.reason).toBe('rate_limit');
    expect(classifyFailoverReason(new Error('too many requests'))?.reason).toBe('rate_limit');
    expect(classifyFailoverReason(new Error('quota exceeded'))?.reason).toBe('rate_limit');
    expect(classifyFailoverReason(new Error('resource exhausted'))?.reason).toBe('rate_limit');
  });

  test('auth patterns', () => {
    expect(classifyFailoverReason(new Error('unauthorized'))?.reason).toBe('auth');
    expect(classifyFailoverReason(new Error('invalid api key'))?.reason).toBe('auth');
    expect(classifyFailoverReason(new Error('authentication required'))?.reason).toBe('auth');
  });

  test('billing patterns', () => {
    expect(classifyFailoverReason(new Error('billing issue'))?.reason).toBe('billing');
    expect(classifyFailoverReason(new Error('payment required'))?.reason).toBe('billing');
    expect(classifyFailoverReason(new Error('insufficient credits'))?.reason).toBe('billing');
  });

  test('timeout patterns', () => {
    expect(classifyFailoverReason(new Error('request timed out'))?.reason).toBe('timeout');
    expect(classifyFailoverReason(new Error('deadline exceeded'))?.reason).toBe('timeout');
    expect(classifyFailoverReason(new Error('fetch failed'))?.reason).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// classifyFailoverReason — null for unclassifiable
// ---------------------------------------------------------------------------
describe('classifyFailoverReason — unclassifiable', () => {
  test('null/undefined/string returns null', () => {
    expect(classifyFailoverReason(null)).toBeNull();
    expect(classifyFailoverReason(undefined)).toBeNull();
    expect(classifyFailoverReason('plain string')).toBeNull();
  });

  test('generic error with no matching pattern returns null', () => {
    expect(classifyFailoverReason(new Error('Something unexpected happened'))).toBeNull();
  });

  test('empty object returns null', () => {
    expect(classifyFailoverReason({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isBackendScoped / shouldAbortChain
// ---------------------------------------------------------------------------
describe('isBackendScoped', () => {
  test('auth and billing are backend-scoped', () => {
    expect(isBackendScoped('auth')).toBe(true);
    expect(isBackendScoped('billing')).toBe(true);
  });

  test('other reasons are not backend-scoped', () => {
    expect(isBackendScoped('rate_limit')).toBe(false);
    expect(isBackendScoped('timeout')).toBe(false);
    expect(isBackendScoped('context_length')).toBe(false);
    expect(isBackendScoped('format')).toBe(false);
    expect(isBackendScoped('unknown')).toBe(false);
  });
});

describe('shouldAbortChain', () => {
  test('context_length and format abort the chain', () => {
    expect(shouldAbortChain('context_length')).toBe(true);
    expect(shouldAbortChain('format')).toBe(true);
  });

  test('other reasons do not abort the chain', () => {
    expect(shouldAbortChain('auth')).toBe(false);
    expect(shouldAbortChain('billing')).toBe(false);
    expect(shouldAbortChain('rate_limit')).toBe(false);
    expect(shouldAbortChain('timeout')).toBe(false);
    expect(shouldAbortChain('unknown')).toBe(false);
  });
});

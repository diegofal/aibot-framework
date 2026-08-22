import { describe, expect, test } from 'bun:test';
import { classifyError, isRetryableError } from '../src/bot/agent-retry-engine';
import { createClaudeCliError } from '../src/claude-cli';

/** Exact blob captured from a production Claude CLI session-limit failure. */
const PRODUCTION_BLOB = JSON.stringify({
  is_error: true,
  terminal_reason: 'api_error',
  api_error_status: 429,
  result: "You've hit your session limit · resets 12:20pm (America/Argentina/Buenos_Aires)",
  permission_denials: [],
  subtype: 'success',
  type: 'result',
  session_id: 'abcd-1234',
});

describe('classifyError — structured Claude CLI errors', () => {
  test('the production session-limit blob classifies CONTEXTUAL, not PERMANENT', () => {
    const err = createClaudeCliError(1, PRODUCTION_BLOB, PRODUCTION_BLOB, {
      now: new Date('2026-08-22T13:00:00Z'),
    });
    const classified = classifyError(err);

    expect(classified.type).toBe('CONTEXTUAL');
    expect(classified.code).toBe('429');
    expect(classified.failoverReason).toBe('rate_limit');
    expect(classified.resetsAt?.toISOString()).toBe('2026-08-22T15:20:00.000Z');
    expect(isRetryableError(err)).toBe(true);
  });

  test('the same blob as a plain Error string still classifies CONTEXTUAL', () => {
    const classified = classifyError(
      new Error(`Claude CLI exited with code 1: ${PRODUCTION_BLOB}`)
    );
    expect(classified.type).toBe('CONTEXTUAL');
  });

  test('apiErrorStatus 401 classifies PERMANENT', () => {
    const err = Object.assign(new Error('Claude CLI exited with code 1: {}'), {
      apiErrorStatus: 401,
    });
    const classified = classifyError(err);
    expect(classified.type).toBe('PERMANENT');
    expect(classified.code).toBe('401');
    expect(classified.failoverReason).toBe('auth');
  });

  test('apiErrorStatus 403 classifies PERMANENT', () => {
    const err = Object.assign(new Error('nope'), { apiErrorStatus: 403 });
    expect(classifyError(err).type).toBe('PERMANENT');
  });

  test('apiErrorStatus 5xx classifies TRANSIENT', () => {
    const err = Object.assign(new Error('upstream blew up'), { apiErrorStatus: 503 });
    const classified = classifyError(err);
    expect(classified.type).toBe('TRANSIENT');
    expect(classified.code).toBe('503');
  });

  test('an unmapped apiErrorStatus falls through to pattern matching', () => {
    const err = Object.assign(new Error('rate limit hit'), { apiErrorStatus: 418 });
    expect(classifyError(err).type).toBe('CONTEXTUAL');
  });
});

describe('classifyError — JSON keys never decide the class', () => {
  test('a bare permission_denials key does not yield PERMANENT', () => {
    expect(classifyError(new Error('{"permission_denials":[]}')).type).not.toBe('PERMANENT');
  });

  test('other auth-shaped JSON keys do not yield PERMANENT', () => {
    expect(classifyError(new Error('{"auth_source":"cli","forbidden_paths":[]}')).type).not.toBe(
      'PERMANENT'
    );
  });

  test('a permission word in real prose still yields PERMANENT', () => {
    expect(classifyError(new Error('permission denied for this model')).type).toBe('PERMANENT');
  });
});

describe('classifyError — existing behaviour preserved', () => {
  test('invalid api key stays PERMANENT', () => {
    expect(classifyError(new Error('invalid api key')).type).toBe('PERMANENT');
    expect(isRetryableError(new Error('invalid api key'))).toBe(false);
  });

  test('HTTP 401 text stays PERMANENT', () => {
    expect(classifyError(new Error('HTTP 401: unauthorized')).type).toBe('PERMANENT');
  });

  test('authentication failure stays PERMANENT', () => {
    expect(classifyError(new Error('authentication failed')).type).toBe('PERMANENT');
  });

  test('forbidden stays PERMANENT', () => {
    expect(classifyError(new Error('403 Forbidden')).type).toBe('PERMANENT');
  });

  test('missing credentials stays PERMANENT', () => {
    expect(classifyError(new Error('missing credentials in CLAUDE_CONFIG_DIR')).type).toBe(
      'PERMANENT'
    );
  });

  test('rate limits stay CONTEXTUAL', () => {
    expect(classifyError(new Error('Ollama API error: 429 Too Many Requests')).type).toBe(
      'CONTEXTUAL'
    );
    expect(classifyError(new Error('rate limit exceeded')).type).toBe('CONTEXTUAL');
    expect(classifyError(new Error('quota exhausted')).type).toBe('CONTEXTUAL');
    expect(classifyError(new Error('request was throttled')).type).toBe('CONTEXTUAL');
  });

  test('network and timeout errors stay TRANSIENT', () => {
    expect(classifyError(new Error('fetch failed')).type).toBe('TRANSIENT');
    expect(classifyError(new Error('The operation timed out')).type).toBe('TRANSIENT');
    expect(classifyError(new Error('AbortError: aborted')).type).toBe('TRANSIENT');
    expect(classifyError(new Error('ECONNREFUSED 127.0.0.1:11434')).type).toBe('TRANSIENT');
    expect(classifyError(new Error('503 Service Unavailable')).type).toBe('TRANSIENT');
  });

  test('unclassifiable errors stay UNKNOWN', () => {
    expect(classifyError(new Error('something odd happened')).type).toBe('UNKNOWN');
  });

  test('structured HTTP status objects still classify', () => {
    expect(classifyError({ status: 429, message: 'slow down' }).type).toBe('CONTEXTUAL');
    expect(classifyError({ status: 401, message: 'nope' }).type).toBe('PERMANENT');
  });
});

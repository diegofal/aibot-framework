/**
 * What a chat sees when the LLM call fails. Live (2026-10-15) the Claude
 * account hit its weekly limit: the conversation retried the 429 four times
 * and answered "Failed to generate response. Please try again later." with no
 * hint of why or until when. A quota error is now its own kind, never
 * retried, and the operator's chat gets the detail.
 */
import { describe, expect, test } from 'bun:test';
import { LLMCallFailedError, describeLLMFailure } from '../../src/bot/llm-error-message';
import { classifyLLMError, formatLLMErrorForUser } from '../../src/bot/llm-resilience';
import { ClaudeCliError } from '../../src/claude-cli';

const NOW = Date.parse('2026-10-15T12:45:00Z');
const RESETS = new Date('2026-10-15T18:00:00Z');

const weekly = () =>
  new ClaudeCliError('Claude CLI exited with code 1: {…}', 1, {
    apiErrorStatus: 429,
    isError: true,
    terminalReason: 'api_error',
    resultText: "You've hit your weekly limit · resets 3pm (America/Argentina/Buenos_Aires)",
    resetsAt: RESETS,
  });

const failed = (err: unknown, attempts = 1) =>
  new LLMCallFailedError(classifyLLMError(err), { attempts, backend: 'claude-cli' });

describe('classifyLLMError: account limits', () => {
  test('a Claude 429 with a reset time is a quota error, never retried', () => {
    const info = classifyLLMError(weekly());
    expect(info.category).toBe('quota');
    expect(info.retryable).toBe(false);
    expect(info.message).toContain('weekly limit');
  });

  test('a Claude 429 without a reset hint is still a quota error', () => {
    const err = new ClaudeCliError('x', 1, {
      apiErrorStatus: 429,
      resultText: 'Usage limit reached',
    });
    expect(classifyLLMError(err).category).toBe('quota');
  });

  test('a plain rate-limit message stays transient (retried)', () => {
    expect(classifyLLMError(new Error('429 too many requests')).category).toBe('transient');
  });

  test('formatLLMErrorForUser names the limit', () => {
    expect(formatLLMErrorForUser(classifyLLMError(weekly()))).toContain('usage limit');
  });
});

describe('describeLLMFailure', () => {
  test('the operator sees the backend, status, the provider message, when it resets and the attempts', () => {
    const text = describeLLMFailure(failed(weekly()), { detailed: true, nowMs: NOW });
    expect(text).toContain('usage limit');
    expect(text).toContain('claude-cli');
    expect(text).toContain('HTTP 429');
    expect(text).toContain('api_error');
    expect(text).toContain(
      "You've hit your weekly limit · resets 3pm (America/Argentina/Buenos_Aires)"
    );
    expect(text).toContain('in 5h 15m');
    expect(text).toContain('1 attempt');
  });

  test('anyone else gets the reason and when, without the provider text', () => {
    const text = describeLLMFailure(failed(weekly()), { detailed: false, nowMs: NOW });
    expect(text).toContain('usage limit');
    expect(text).toContain('in 5h 15m');
    expect(text).not.toContain('api_error');
    expect(text).not.toContain('America/Argentina');
  });

  test('not logged in: says so, with the fix for the operator', () => {
    const err = new ClaudeCliError('x', 1, {
      isError: true,
      resultText: 'Not logged in · Please run /login',
    });
    const text = describeLLMFailure(failed(err), { detailed: true, nowMs: NOW });
    expect(text).toContain('not logged in');
    expect(text).toContain('claude auth login');
  });

  test('a generic failure shows its category and message to the operator only', () => {
    const err = new Error('socket hang up');
    const op = describeLLMFailure(failed(err, 4), { detailed: true, nowMs: NOW });
    expect(op).toContain('transient');
    expect(op).toContain('socket hang up');
    expect(op).toContain('4 attempts');
    const other = describeLLMFailure(failed(err, 4), { detailed: false, nowMs: NOW });
    expect(other).not.toContain('socket hang up');
  });

  test('the known kinds keep their message: circuit open, timeout, context length', () => {
    expect(
      describeLLMFailure(new Error('Circuit breaker is open - x'), { detailed: false })
    ).toContain('temporarily overloaded');
    expect(describeLLMFailure(new Error('request timed out'), { detailed: false })).toContain(
      'took too long'
    );
    expect(describeLLMFailure(new Error('context length exceeded'), { detailed: false })).toContain(
      'too long'
    );
  });

  test('LLMCallFailedError keeps the old message for logs and callers that match on it', () => {
    const e = failed(weekly());
    expect(e.message).toStartWith('LLM call failed: ');
    expect(e).toBeInstanceOf(Error);
  });
});

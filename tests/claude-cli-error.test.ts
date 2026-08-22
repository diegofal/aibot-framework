import { describe, expect, test } from 'bun:test';
import { ClaudeCliError, createClaudeCliError, parseResetsAt } from '../src/claude-cli';

/**
 * The exact shape the Claude CLI writes to stdout when a session rate limit is
 * hit (captured in production). Note `permission_denials` — the JSON *key* that
 * used to make the retry engine call this a permanent auth error.
 */
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

describe('parseResetsAt', () => {
  test('resolves a 12-hour time in a named timezone to an absolute instant', () => {
    // 12:20pm in America/Argentina/Buenos_Aires (UTC-3) === 15:20 UTC
    const now = new Date('2026-08-22T13:00:00Z'); // 10:00 in Buenos Aires
    const at = parseResetsAt(
      "You've hit your session limit · resets 12:20pm (America/Argentina/Buenos_Aires)",
      now
    );
    expect(at).toBeInstanceOf(Date);
    expect(at?.toISOString()).toBe('2026-08-22T15:20:00.000Z');
  });

  test('a time already past today rolls over to the next day', () => {
    const now = new Date('2026-08-22T18:00:00Z'); // 15:00 in Buenos Aires, past 12:20
    const at = parseResetsAt('resets 12:20pm (America/Argentina/Buenos_Aires)', now);
    expect(at?.toISOString()).toBe('2026-08-23T15:20:00.000Z');
  });

  test('handles a bare hour with no minutes', () => {
    const now = new Date('2026-08-22T01:00:00Z'); // 22:00 Aug 21 in Buenos Aires
    const at = parseResetsAt('resets 11pm (America/Argentina/Buenos_Aires)', now);
    expect(at?.toISOString()).toBe('2026-08-22T02:00:00.000Z');
  });

  test('12am is midnight, not noon', () => {
    const now = new Date('2026-08-22T04:00:00Z'); // 01:00 Aug 22 in Buenos Aires
    const at = parseResetsAt('resets 12am (America/Argentina/Buenos_Aires)', now);
    // next midnight in Buenos Aires === 2026-08-23T03:00:00Z
    expect(at?.toISOString()).toBe('2026-08-23T03:00:00.000Z');
  });

  test('falls back to host-local time when the timezone is unusable', () => {
    const now = new Date('2026-08-22T13:00:00Z');
    const at = parseResetsAt('resets 9:05am (Not/A_Real_Zone)', now);
    expect(at).toBeInstanceOf(Date);
    expect(at?.getHours()).toBe(9);
    expect(at?.getMinutes()).toBe(5);
  });

  test('falls back to host-local time when no timezone is given', () => {
    const at = parseResetsAt('resets 7:30pm', new Date('2026-08-22T13:00:00Z'));
    expect(at?.getHours()).toBe(19);
    expect(at?.getMinutes()).toBe(30);
  });

  test('lands on an exact minute even when now carries a sub-second remainder', () => {
    const at = parseResetsAt(
      'resets 12:20pm (America/Argentina/Buenos_Aires)',
      new Date('2026-08-22T13:00:00.743Z')
    );
    expect(at?.toISOString()).toBe('2026-08-22T15:20:00.000Z');
  });

  test('returns undefined when there is no resets hint', () => {
    expect(parseResetsAt("You've hit your session limit")).toBeUndefined();
  });

  test('returns undefined for an unparseable resets hint', () => {
    expect(parseResetsAt('resets soon, hang tight')).toBeUndefined();
    expect(parseResetsAt('resets 99:99xm (Nowhere)')).toBeUndefined();
  });

  test('never throws on junk input', () => {
    expect(() => parseResetsAt('')).not.toThrow();
    expect(() => parseResetsAt('resets')).not.toThrow();
    expect(parseResetsAt('')).toBeUndefined();
  });
});

describe('createClaudeCliError', () => {
  test('lifts the structured fields out of the CLI result JSON', () => {
    const err = createClaudeCliError(1, PRODUCTION_BLOB, PRODUCTION_BLOB, {
      now: new Date('2026-08-22T13:00:00Z'),
    });

    expect(err).toBeInstanceOf(ClaudeCliError);
    expect(err).toBeInstanceOf(Error);
    expect(err.exitCode).toBe(1);
    expect(err.apiErrorStatus).toBe(429);
    expect(err.isError).toBe(true);
    expect(err.terminalReason).toBe('api_error');
    expect(err.resultText).toContain('session limit');
    expect(err.resetsAt?.toISOString()).toBe('2026-08-22T15:20:00.000Z');
  });

  test('keeps the human-readable message shape callers and logs rely on', () => {
    const err = createClaudeCliError(1, PRODUCTION_BLOB, PRODUCTION_BLOB);
    expect(err.message).toBe(`Claude CLI exited with code 1: ${PRODUCTION_BLOB}`);
    expect(err.name).toBe('ClaudeCliError');
  });

  test('still produces a typed error when stdout is not JSON', () => {
    const err = createClaudeCliError(143, 'killed', '');
    expect(err).toBeInstanceOf(ClaudeCliError);
    expect(err.exitCode).toBe(143);
    expect(err.apiErrorStatus).toBeUndefined();
    expect(err.resetsAt).toBeUndefined();
    expect(err.message).toBe('Claude CLI exited with code 143: killed');
  });

  test('ignores JSON that is not a CLI result object', () => {
    const err = createClaudeCliError(1, '[1,2,3]', '[1,2,3]');
    expect(err.apiErrorStatus).toBeUndefined();
    expect(err.terminalReason).toBeUndefined();
    expect(err.isError).toBeUndefined();
  });

  test('parses structured fields out of the raw stdout when detail came from stderr', () => {
    const err = createClaudeCliError(1, 'some stderr noise', PRODUCTION_BLOB);
    expect(err.apiErrorStatus).toBe(429);
    expect(err.message).toBe('Claude CLI exited with code 1: some stderr noise');
  });

  test('tolerates a result object with no api_error_status', () => {
    const blob = JSON.stringify({ type: 'result', is_error: true, result: 'something broke' });
    const err = createClaudeCliError(1, blob, blob);
    expect(err.apiErrorStatus).toBeUndefined();
    expect(err.isError).toBe(true);
    expect(err.resultText).toBe('something broke');
  });
});

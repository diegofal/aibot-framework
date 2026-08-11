/**
 * Telegram failure classification.
 *
 * 409 exists as its own case because it is the failure that lies: it presents
 * as a flaky bot rather than as a second consumer on the token, and it is the
 * most likely way an automatic boot-time start goes wrong during a cutover.
 */
import { describe, expect, test } from 'bun:test';
import { GrammyError } from 'grammy';
import {
  TELEGRAM_CONFLICT_EXPLANATION,
  describeTelegramStartFailure,
  isTelegramConflictError,
  isTelegramUnauthorizedError,
} from '../../src/bot/telegram-errors';

function grammyError(code: number, description: string): GrammyError {
  return new GrammyError(
    description,
    { ok: false, error_code: code, description } as never,
    'getUpdates',
    {}
  );
}

describe('isTelegramConflictError', () => {
  test('matches a real grammy 409', () => {
    expect(
      isTelegramConflictError(grammyError(409, 'Conflict: terminated by other getUpdates request'))
    ).toBe(true);
  });

  test('matches a plain object carrying error_code — the error may arrive wrapped', () => {
    expect(isTelegramConflictError({ error_code: 409 })).toBe(true);
  });

  test('matches on message text when the code was lost', () => {
    expect(
      isTelegramConflictError(new Error('Conflict: terminated by other getUpdates request'))
    ).toBe(true);
  });

  test('does not match unrelated failures', () => {
    expect(isTelegramConflictError(new Error('fetch failed'))).toBe(false);
    expect(isTelegramConflictError(grammyError(401, 'Unauthorized'))).toBe(false);
    expect(isTelegramConflictError(undefined)).toBe(false);
  });
});

describe('isTelegramUnauthorizedError', () => {
  test('matches a 401', () => {
    expect(isTelegramUnauthorizedError(grammyError(401, 'Unauthorized'))).toBe(true);
  });

  test('does not match a 409', () => {
    expect(isTelegramUnauthorizedError(grammyError(409, 'Conflict'))).toBe(false);
  });
});

describe('describeTelegramStartFailure', () => {
  test('a 409 names the duplicate-consumer cause', () => {
    const description = describeTelegramStartFailure(grammyError(409, 'Conflict'));
    expect(description).toBe(TELEGRAM_CONFLICT_EXPLANATION);
    expect(description).toContain('ANOTHER PROCESS IS ALREADY POLLING');
    expect(description).toContain('getUpdates');
  });

  test('a 401 blames the token, not a phantom second instance', () => {
    const description = describeTelegramStartFailure(grammyError(401, 'Unauthorized'));
    expect(description).toContain('401');
    expect(description).not.toContain('ANOTHER PROCESS');
  });

  test('anything else is reported verbatim rather than guessed at', () => {
    expect(describeTelegramStartFailure(new Error('ECONNREFUSED 149.154.167.220:443'))).toContain(
      'ECONNREFUSED'
    );
  });
});

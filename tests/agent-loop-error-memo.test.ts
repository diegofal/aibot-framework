import { describe, expect, test } from 'bun:test';
import { ERROR_MEMO_WINDOW_MS, shouldRecordErrorInMemory } from '../src/bot/agent-loop-utils';

// An outage the circuit breaker does not cover — an expired Claude CLI OAuth
// session classifies PERMANENT, so the circuit stays closed (correctly: retrying
// cannot help). Without a memo, every bot wrote the identical error into its
// daily memory on every cycle, polluting the soul files for the whole outage.

const NOW = Date.parse('2026-08-22T09:00:00.000Z');
const ERR = 'Agent loop error: Failed to authenticate: OAuth session expired';

describe('shouldRecordErrorInMemory', () => {
  test('records the first occurrence', () => {
    expect(shouldRecordErrorInMemory(undefined, ERR, NOW)).toBe(true);
  });

  test('suppresses the same message inside the window', () => {
    const last = { message: ERR, at: NOW - 60_000 };
    expect(shouldRecordErrorInMemory(last, ERR, NOW)).toBe(false);
  });

  test('records the same message again once the window has passed', () => {
    const last = { message: ERR, at: NOW - ERROR_MEMO_WINDOW_MS - 1 };
    expect(shouldRecordErrorInMemory(last, ERR, NOW)).toBe(true);
  });

  test('records a different message immediately', () => {
    const last = { message: ERR, at: NOW - 60_000 };
    expect(shouldRecordErrorInMemory(last, 'Agent loop error: something else', NOW)).toBe(true);
  });

  test('window boundary is inclusive of the elapsed window', () => {
    const last = { message: ERR, at: NOW - ERROR_MEMO_WINDOW_MS };
    expect(shouldRecordErrorInMemory(last, ERR, NOW)).toBe(true);
  });
});

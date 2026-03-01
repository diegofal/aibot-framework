import { describe, expect, test } from 'bun:test';
import { localDateStr, localTimeStr } from '../src/date-utils';

describe('localDateStr', () => {
  test('returns YYYY-MM-DD format', () => {
    const result = localDateStr(new Date(2026, 1, 22)); // Feb 22, 2026 local
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toBe('2026-02-22');
  });

  test('defaults to current date', () => {
    const result = localDateStr();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('respects TZ (01:30 UTC → previous day in UTC-3)', () => {
    const origTZ = process.env.TZ;
    try {
      process.env.TZ = 'America/Argentina/Buenos_Aires';

      // 2026-02-22 01:30 UTC → 2026-02-21 22:30 ART (UTC-3)
      const utcDate = new Date('2026-02-22T01:30:00Z');
      const result = localDateStr(utcDate);
      expect(result).toBe('2026-02-21');
    } finally {
      process.env.TZ = origTZ;
    }
  });

  test('does not change when date is well within the day', () => {
    const origTZ = process.env.TZ;
    try {
      process.env.TZ = 'America/Argentina/Buenos_Aires';

      // 2026-02-22 15:00 UTC → 2026-02-22 12:00 ART
      const utcDate = new Date('2026-02-22T15:00:00Z');
      const result = localDateStr(utcDate);
      expect(result).toBe('2026-02-22');
    } finally {
      process.env.TZ = origTZ;
    }
  });
});

describe('localTimeStr', () => {
  test('returns HH:MM format', () => {
    const result = localTimeStr(new Date(2026, 1, 22, 14, 30));
    expect(result).toMatch(/^\d{2}:\d{2}$/);
    expect(result).toBe('14:30');
  });

  test('defaults to current time', () => {
    const result = localTimeStr();
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });

  test('respects TZ', () => {
    const origTZ = process.env.TZ;
    try {
      process.env.TZ = 'America/Argentina/Buenos_Aires';

      // 2026-02-22 01:30 UTC → 22:30 ART
      const utcDate = new Date('2026-02-22T01:30:00Z');
      const result = localTimeStr(utcDate);
      expect(result).toBe('22:30');
    } finally {
      process.env.TZ = origTZ;
    }
  });
});

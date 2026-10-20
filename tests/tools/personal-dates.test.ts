/**
 * Dates in the personal tools (prepass findings, 2026-10-20):
 * - an impossible date (2026-02-31) is refused, not rolled over to March 3;
 * - an all-day event stays on its calendar date in a negative UTC offset
 *   (it was UTC midnight, so the operator in UTC-3 saw it a day early).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { googleProvider } from '../../src/personal-accounts/providers/google';
import { microsoftProvider } from '../../src/personal-accounts/providers/microsoft';
import type { AccountApi } from '../../src/personal-accounts/providers/types';
import { parseWhen } from '../../src/tools/personal/index';

describe('parseWhen refuses impossible dates', () => {
  test('a day past the end of the month is null', () => {
    expect(parseWhen('2026-02-31')).toBeNull();
    expect(parseWhen('2026-04-31')).toBeNull();
    expect(parseWhen('2026-13-01')).toBeNull();
    expect(parseWhen('2026-02-31T10:00')).toBeNull();
  });

  test('real dates still parse', () => {
    const d = parseWhen('2026-02-28');
    expect(d && [d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 1, 28]);
    expect(parseWhen('2028-02-29')).not.toBeNull();
    expect(parseWhen('2026-10-20T10:00:00Z')?.toISOString()).toBe('2026-10-20T10:00:00.000Z');
  });
});

describe('all-day events keep their date in UTC-3', () => {
  const tz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/Argentina/Buenos_Aires';
  });
  afterAll(() => {
    process.env.TZ = tz;
  });

  const once = (body: unknown) => (async () => body) as unknown as AccountApi;
  const FROM = new Date('2026-10-19T00:00:00Z');
  const TO = new Date('2026-10-26T00:00:00Z');
  const localDay = (iso: string) => {
    const d = new Date(iso);
    return [d.getMonth() + 1, d.getDate(), d.getHours()];
  };

  test('Google date-only event', async () => {
    const [e] = await googleProvider.listEvents(
      once({ items: [{ id: 'h', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } }] }),
      FROM,
      TO
    );
    expect(e.allDay).toBe(true);
    expect(localDay(e.start)).toEqual([10, 20, 0]);
    expect(localDay(e.end)).toEqual([10, 21, 0]);
  });

  test('Microsoft all-day event (UTC midnight from Graph)', async () => {
    const [e] = await microsoftProvider.listEvents(
      once({
        value: [
          {
            id: 'h',
            isAllDay: true,
            start: { dateTime: '2026-10-20T00:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-10-21T00:00:00.0000000', timeZone: 'UTC' },
          },
        ],
      }),
      FROM,
      TO
    );
    expect(localDay(e.start)).toEqual([10, 20, 0]);
  });

  test('a timed event is untouched', async () => {
    const [e] = await googleProvider.listEvents(
      once({
        items: [
          {
            id: 't',
            start: { dateTime: '2026-10-20T13:00:00Z' },
            end: { dateTime: '2026-10-20T14:00:00Z' },
          },
        ],
      }),
      FROM,
      TO
    );
    expect(e.start).toBe('2026-10-20T13:00:00.000Z');
  });
});

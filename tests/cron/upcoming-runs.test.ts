import { describe, expect, test } from 'bun:test';
import { upcomingRunsMs, weekOfRunsMs } from '../../src/cron/schedule';

const H = 3_600_000;
const D = 24 * H;
const MON_0000_UTC = Date.UTC(2026, 9, 19); // Monday 2026-10-19

describe('upcomingRunsMs', () => {
  test('a daily cron: one run per day inside the window', () => {
    const runs = upcomingRunsMs(
      { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
      MON_0000_UTC,
      MON_0000_UTC + 3 * D
    );
    expect(runs).toEqual([0, 1, 2].map((i) => MON_0000_UTC + i * D + 9 * H));
  });

  test('a weekly cron in a timezone', () => {
    const runs = upcomingRunsMs(
      { kind: 'cron', expr: '0 9 * * 1', tz: 'America/Argentina/Buenos_Aires' },
      MON_0000_UTC,
      MON_0000_UTC + 7 * D
    );
    expect(runs).toEqual([MON_0000_UTC + 12 * H]); // 09:00 -03:00
  });

  test('every N ms from its anchor', () => {
    const runs = upcomingRunsMs(
      { kind: 'every', everyMs: 2 * D, anchorMs: MON_0000_UTC },
      MON_0000_UTC,
      MON_0000_UTC + 5 * D
    );
    expect(runs).toEqual([MON_0000_UTC + 2 * D, MON_0000_UTC + 4 * D]);
  });

  test('an interval under a second lists every run, none skipped', () => {
    const runs = upcomingRunsMs(
      { kind: 'every', everyMs: 500, anchorMs: MON_0000_UTC },
      MON_0000_UTC,
      MON_0000_UTC + 2000
    );
    expect(runs).toEqual([500, 1000, 1500].map((ms) => MON_0000_UTC + ms));
  });

  test('a cron with a seconds field firing every second lists every second', () => {
    const runs = upcomingRunsMs(
      { kind: 'cron', expr: '* * * * * *', tz: 'UTC' },
      MON_0000_UTC,
      MON_0000_UTC + 4000
    );
    expect(runs).toEqual([1000, 2000, 3000].map((ms) => MON_0000_UTC + ms));
  });

  test('weekOfRunsMs: an hourly job fills every day of the week, not only the first 50 runs', () => {
    const runs = weekOfRunsMs({ kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, MON_0000_UTC);
    expect(runs.length).toBe(7 * 24 - 1);
    expect(runs.at(-1)).toBe(MON_0000_UTC + 7 * D - H);
  });

  test('weekOfRunsMs caps each day, so a per-second job stays bounded', () => {
    const runs = weekOfRunsMs(
      { kind: 'every', everyMs: 1000, anchorMs: MON_0000_UTC },
      MON_0000_UTC
    );
    expect(runs.length).toBeLessThanOrEqual(7 * 50);
    expect(runs.at(-1)).toBeGreaterThanOrEqual(MON_0000_UTC + 6 * D);
  });

  test('weekOfRunsMs never lists a run twice, even one right before a day boundary', () => {
    const runs = weekOfRunsMs(
      { kind: 'every', everyMs: D, anchorMs: MON_0000_UTC + D - 1 },
      MON_0000_UTC
    );
    expect(new Set(runs).size).toBe(runs.length);
    expect(runs[0]).toBe(MON_0000_UTC + D - 1);
  });

  test('a one-shot only when it is still ahead', () => {
    const at = new Date(MON_0000_UTC + H).toISOString();
    expect(upcomingRunsMs({ kind: 'at', at }, MON_0000_UTC, MON_0000_UTC + D)).toEqual([
      MON_0000_UTC + H,
    ]);
    expect(upcomingRunsMs({ kind: 'at', at }, MON_0000_UTC + 2 * H, MON_0000_UTC + D)).toEqual([]);
  });

  test('capped, and empty for a bad expression', () => {
    expect(
      upcomingRunsMs(
        { kind: 'cron', expr: '* * * * *', tz: 'UTC' },
        MON_0000_UTC,
        MON_0000_UTC + D,
        5
      )
    ).toHaveLength(5);
    expect(upcomingRunsMs({ kind: 'cron', expr: 'nope' }, MON_0000_UTC, MON_0000_UTC + D)).toEqual(
      []
    );
  });
});

import { describe, expect, test } from 'bun:test';
import { upcomingRunsMs } from '../../src/cron/schedule';

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

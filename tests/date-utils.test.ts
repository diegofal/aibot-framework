import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { localDateStr, localTimeStr } from '../src/date-utils';

const DATE_UTILS = join(import.meta.dir, '..', 'src', 'date-utils.ts');

/**
 * Runs the helper in a child process started with `TZ` in its environment —
 * how production sets it (once, at boot, in src/index.ts). Switching
 * `process.env.TZ` mid-suite is not reliable: on Linux, once enough of the
 * suite has run in the same process, Bun stops picking the change up.
 */
function inTz(tz: string, fn: 'localDateStr' | 'localTimeStr', iso: string): string {
  const script = `const m = await import(${JSON.stringify(DATE_UTILS)}); process.stdout.write(m.${fn}(new Date(${JSON.stringify(iso)})));`;
  const proc = Bun.spawnSync([process.execPath, '-e', script], {
    env: { ...process.env, TZ: tz },
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString();
}

const ART = 'America/Argentina/Buenos_Aires';

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
    // 2026-02-22 01:30 UTC → 2026-02-21 22:30 ART (UTC-3)
    expect(inTz(ART, 'localDateStr', '2026-02-22T01:30:00Z')).toBe('2026-02-21');
  });

  test('does not change when date is well within the day', () => {
    // 2026-02-22 15:00 UTC → 2026-02-22 12:00 ART
    expect(inTz(ART, 'localDateStr', '2026-02-22T15:00:00Z')).toBe('2026-02-22');
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
    // 2026-02-22 01:30 UTC → 22:30 ART
    expect(inTz(ART, 'localTimeStr', '2026-02-22T01:30:00Z')).toBe('22:30');
  });
});

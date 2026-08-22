import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLogTail, scanLogs, selectLogFiles } from '../../src/stats/readers/logs';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

// pino-roll writes to `aibot.log.N`; the bare `aibot.log` can be a stale
// pre-rotation file that is months old. The reader must follow the newest
// file by mtime, not the configured basename.
let dir: string;
beforeEach(() => {
  dir = createTempDir('stats-logs');
});
afterEach(() => removeTempDir(dir));

function line(time: number, msg: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ level: 30, time, msg, ...extra })}\n`;
}

function touch(path: string, ageMs: number, now: number): void {
  const t = new Date(now - ageMs);
  utimesSync(path, t, t);
}

describe('selectLogFiles', () => {
  it('orders the base file and its rotated siblings newest-first by mtime', () => {
    const now = Date.now();
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    const base = join(logs, 'aibot.log');
    writeFileSync(base, 'old');
    writeFileSync(join(logs, 'aibot.log.1'), 'newest');
    writeFileSync(join(logs, 'aibot.log.3'), 'mid');
    writeFileSync(join(logs, 'other.txt'), 'ignored');
    touch(base, 5 * 86_400_000, now);
    touch(join(logs, 'aibot.log.1'), 0, now);
    touch(join(logs, 'aibot.log.3'), 3_600_000, now);

    expect(selectLogFiles(base).map((p) => p.slice(logs.length + 1))).toEqual([
      'aibot.log.1',
      'aibot.log.3',
      'aibot.log',
    ]);
  });

  it('returns an empty list when the directory is missing', () => {
    expect(selectLogFiles(join(dir, 'nope', 'aibot.log'))).toEqual([]);
  });
});

describe('readLogTail / scanLogs across rotated files', () => {
  it('reads the newest sibling even when the base file is stale', () => {
    const now = Date.now();
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    const base = join(logs, 'aibot.log');
    writeFileSync(base, line(now - 30 * 86_400_000, 'Starting AIBot Framework v1.0.0'));
    writeFileSync(join(logs, 'aibot.log.1'), line(now - 60_000, 'Starting AIBot Framework v1.0.0'));
    touch(base, 30 * 86_400_000, now);
    touch(join(logs, 'aibot.log.1'), 0, now);

    const text = readLogTail(base, 1024 * 1024);
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);

    const sig = scanLogs(base, { maxBytes: 1024 * 1024, sinceMs: now - 86_400_000, nowMs: now });
    expect(sig.boots).toHaveLength(1);
  });

  it('records the most recent completed cycle per bot (lastAt)', () => {
    const now = Date.now();
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    const base = join(logs, 'aibot.log');
    writeFileSync(
      base,
      line(now - 7_200_000, 'Agent loop completed for bot', { botId: 'b1', durationMs: 10 }) +
        line(now - 3_600_000, 'Agent loop completed for bot', { botId: 'b1', durationMs: 20 }) +
        line(now - 5_400_000, 'Agent loop completed for bot', { botId: 'b2', isIdle: true })
    );
    const sig = scanLogs(base, { maxBytes: 1 << 20, sinceMs: now - 86_400_000, nowMs: now });
    expect(sig.cyclesByBot.b1.lastAt).toBe(now - 3_600_000);
    expect(sig.cyclesByBot.b1.total).toBe(2);
    expect(sig.cyclesByBot.b2.lastAt).toBe(now - 5_400_000);
    expect(sig.cyclesByBot.b2.idle).toBe(1);
  });

  it('stops once the byte budget is spent, newest bytes first', () => {
    const now = Date.now();
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    const base = join(logs, 'aibot.log');
    const newest = join(logs, 'aibot.log.2');
    writeFileSync(base, 'x'.repeat(500));
    writeFileSync(newest, 'y'.repeat(500));
    touch(base, 86_400_000, now);
    touch(newest, 0, now);

    const text = readLogTail(base, 600);
    expect(text).toContain('y'.repeat(500));
    // Only ~100 bytes of budget remained for the older file.
    expect(text.length).toBeLessThanOrEqual(601);
    expect(text.indexOf('x')).toBeLessThan(text.indexOf('y'));
  });
});

import { describe, expect, test } from 'bun:test';
import { findCandidates } from '../../src/bot/self-improve/detector';
import { DETECT_WINDOW_MS, EVIDENCE_MAX } from '../../src/bot/self-improve/types';
import type { ToolAuditEntry } from '../../src/bot/tool-audit-log';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const HOUR = 3_600_000;

function entry(hoursAgo: number, over: Partial<ToolAuditEntry> = {}): ToolAuditEntry {
  return {
    timestamp: new Date(NOW - hoursAgo * HOUR).toISOString(),
    botId: 'scout',
    chatId: 0,
    toolName: 'file_read',
    args: { path: 'x.md' },
    success: false,
    result: 'File not found: /app/productions/scout/x.md',
    durationMs: 3,
    retryAttempts: 0,
    ...over,
  };
}

const ok = (hoursAgo: number, over: Partial<ToolAuditEntry> = {}) =>
  entry(hoursAgo, { success: true, result: '# Notes', ...over });

function run(entries: ToolAuditEntry[], over: Partial<Parameters<typeof findCandidates>[0]> = {}) {
  return findCandidates({
    entries,
    nowMs: NOW,
    minRepeats: 3,
    activeClassKeys: new Set(),
    suppressedClassKeys: new Set(),
    ...over,
  });
}

describe('findCandidates', () => {
  test('a class with minRepeats failures in the window is a candidate, failures newest first', () => {
    const [c, ...rest] = run([entry(5), entry(1), entry(30)]);
    expect(rest).toEqual([]);
    expect(c.cls.key).toBe('file_read:file-not-found');
    expect(c.failures.map((f) => f.timestamp)).toEqual([
      entry(1).timestamp,
      entry(5).timestamp,
      entry(30).timestamp,
    ]);
  });

  test('a class below minRepeats is not a candidate', () => {
    expect(run([entry(1), entry(2)])).toEqual([]);
  });

  test('failures outside the window do not count', () => {
    const outside = DETECT_WINDOW_MS / HOUR + 1;
    expect(run([entry(1), entry(2), entry(outside)])).toEqual([]);
  });

  test('entries after nowMs do not count', () => {
    expect(run([entry(1), entry(2), entry(-1)])).toEqual([]);
  });

  test('a failure exactly at the window start counts', () => {
    expect(run([entry(1), entry(2), entry(DETECT_WINDOW_MS / HOUR)])).toHaveLength(1);
  });

  test('a class with an active lesson is skipped', () => {
    expect(
      run([entry(1), entry(2), entry(3)], {
        activeClassKeys: new Set(['file_read:file-not-found']),
      })
    ).toEqual([]);
  });

  test('a suppressed class is skipped', () => {
    expect(
      run([entry(1), entry(2), entry(3)], {
        suppressedClassKeys: new Set(['file_read:file-not-found']),
      })
    ).toEqual([]);
  });

  test('never-charged failures do not count toward minRepeats', () => {
    const blocked = (h: number) =>
      entry(h, { toolName: 'web_fetch', result: 'wiley.com blocks bots', failureKind: 'blocked' });
    expect(run([blocked(1), blocked(2), blocked(3)])).toEqual([]);
  });

  test('unparseable timestamps are ignored', () => {
    expect(run([entry(1), entry(2), entry(3, { timestamp: 'not a date' })])).toEqual([]);
  });

  test('successes are the same tool in the window, newest first, at most EVIDENCE_MAX', () => {
    const successes = Array.from({ length: EVIDENCE_MAX + 2 }, (_, i) => ok(10 + i));
    const [c] = run([
      entry(1),
      entry(2),
      entry(3),
      ...successes,
      ok(0.5, { toolName: 'web_fetch' }),
      ok(DETECT_WINDOW_MS / HOUR + 2),
    ]);
    expect(c.successes).toHaveLength(EVIDENCE_MAX);
    expect(c.successes.map((s) => s.timestamp)).toEqual(
      successes.slice(0, EVIDENCE_MAX).map((s) => s.timestamp)
    );
  });

  test('candidates sort by failure count desc, then key asc', () => {
    const dir = (h: number) =>
      entry(h, { result: 'Failed to read file: Directories cannot be read like files' });
    const url = (h: number) =>
      entry(h, { toolName: 'web_fetch', result: 'Page does not exist (404 Not Found).' });
    const keys = run([
      dir(1),
      dir(2),
      dir(3),
      url(1),
      url(2),
      url(3),
      url(4),
      entry(1),
      entry(2),
      entry(3),
    ]).map((c) => c.cls.key);
    expect(keys).toEqual([
      'web_fetch:guessed-url',
      'file_read:file-not-found',
      'file_read:read-a-directory',
    ]);
  });
});

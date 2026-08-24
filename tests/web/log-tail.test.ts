import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type LogTailState,
  pollLogTail,
  readAllLogLines,
  readLastLinesRotationAware,
  resolveActiveLogFile,
} from '../../src/web/log-tail';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

// The dashboard's live Logs view (`/ws/logs`) read a fixed path — `config.logging.file`
// — directly with readFileSync/fs.watch. pino-roll rotates by writing to numbered
// siblings (aibot.log.1, .2, ...), so once rotation happens the bare path can be a
// frozen, no-longer-appended-to file. Both the initial "last 100 lines" history and
// the live-tail watcher silently kept reading/watching that stale file forever —
// live evidence: a WS connection returned a week-old MCP-reconnect message as the
// "current" log. This mirrors the exact bug already fixed for the stats reader
// (src/stats/readers/logs.ts) two days ago; this module reuses that fix.

let dir: string;
let logs: string;
let base: string;
beforeEach(() => {
  dir = createTempDir('log-tail');
  logs = join(dir, 'logs');
  mkdirSync(logs);
  base = join(logs, 'aibot.log');
});
afterEach(() => removeTempDir(dir));

function touch(path: string, ageMs: number, now: number): void {
  const t = new Date(now - ageMs);
  utimesSync(path, t, t);
}

describe('resolveActiveLogFile', () => {
  it('picks the newest rotated sibling over a stale bare file', () => {
    const now = Date.now();
    writeFileSync(base, 'old\n');
    writeFileSync(join(logs, 'aibot.log.1'), 'current\n');
    touch(base, 7 * 86_400_000, now);
    touch(join(logs, 'aibot.log.1'), 0, now);
    expect(resolveActiveLogFile(base)).toBe(join(logs, 'aibot.log.1'));
  });
});

describe('readLastLinesRotationAware', () => {
  it('reads the current file, not a stale bare one', () => {
    const now = Date.now();
    writeFileSync(base, '{"msg":"ancient"}\n');
    writeFileSync(join(logs, 'aibot.log.1'), '{"msg":"a"}\n{"msg":"b"}\n{"msg":"c"}\n');
    touch(base, 7 * 86_400_000, now);
    touch(join(logs, 'aibot.log.1'), 0, now);

    const lines = readLastLinesRotationAware(base, 2);
    expect(lines).toEqual(['{"msg":"b"}', '{"msg":"c"}']);
  });

  it('returns [] for a missing log directory', () => {
    expect(readLastLinesRotationAware(join(dir, 'nope', 'aibot.log'), 10)).toEqual([]);
  });
});

describe('readAllLogLines', () => {
  it('spans every rotated sibling in chronological (oldest-first) order, not just the newest file', () => {
    const now = Date.now();
    writeFileSync(base, '{"msg":"oldest"}\n');
    writeFileSync(join(logs, 'aibot.log.2'), '{"msg":"middle"}\n');
    writeFileSync(join(logs, 'aibot.log.1'), '{"msg":"newest"}\n');
    // GET /api/logs used to read only the bare `aibot.log` path directly —
    // once pino-roll stops writing to it, pagination silently loses every
    // line written after the first rotation.
    touch(base, 2 * 86_400_000, now);
    touch(join(logs, 'aibot.log.2'), 86_400_000, now);
    touch(join(logs, 'aibot.log.1'), 0, now);

    expect(readAllLogLines(base)).toEqual([
      '{"msg":"oldest"}',
      '{"msg":"middle"}',
      '{"msg":"newest"}',
    ]);
  });

  it('returns [] for a missing log directory', () => {
    expect(readAllLogLines(join(dir, 'nope', 'aibot.log'))).toEqual([]);
  });
});

describe('pollLogTail', () => {
  it('starts tailing from the end of the file on the first call — no history replay', () => {
    writeFileSync(base, 'pre-existing content\n');
    const state: LogTailState = { path: null, offset: 0 };
    const chunk = pollLogTail(base, state);
    expect(chunk).toBe('');
    expect(state.path).toBe(base);
  });

  it('returns only bytes appended since the last poll', () => {
    writeFileSync(base, 'line1\n');
    const state: LogTailState = { path: null, offset: 0 };
    pollLogTail(base, state); // establishes baseline at current EOF

    writeFileSync(base, 'line1\nline2\n');
    const chunk = pollLogTail(base, state);
    expect(chunk).toBe('line2\n');
  });

  it('returns nothing when the file has not grown', () => {
    writeFileSync(base, 'line1\n');
    const state: LogTailState = { path: null, offset: 0 };
    pollLogTail(base, state);
    expect(pollLogTail(base, state)).toBe('');
  });

  it('detects rotation to a new active file and resumes from its end, not its start', () => {
    const now = Date.now();
    writeFileSync(base, 'old content\n');
    touch(base, 0, now);
    const state: LogTailState = { path: null, offset: 0 };
    pollLogTail(base, state);
    expect(state.path).toBe(base);

    // Rotation: a new sibling becomes the newest file.
    const rotated = join(logs, 'aibot.log.1');
    writeFileSync(rotated, 'rotated-old-content\n');
    touch(rotated, 0, now + 1000);

    const chunkAtRotation = pollLogTail(base, state);
    // The switch itself yields nothing — it must not replay the new file's
    // pre-existing content, only what's appended to it going forward.
    expect(chunkAtRotation).toBe('');
    expect(state.path).toBe(rotated);

    writeFileSync(rotated, 'rotated-old-content\nnew line after rotation\n');
    expect(pollLogTail(base, state)).toBe('new line after rotation\n');
  });

  it('resets to 0 and re-reads from the start when the active file is truncated', () => {
    writeFileSync(base, 'a-long-line-of-content\n');
    const state: LogTailState = { path: null, offset: 0 };
    pollLogTail(base, state);

    writeFileSync(base, 'short\n');
    const chunk = pollLogTail(base, state);
    expect(chunk).toBe('short\n');
  });

  it('never throws when the log file does not exist yet', () => {
    const state: LogTailState = { path: null, offset: 0 };
    expect(() => pollLogTail(join(dir, 'nope.log'), state)).not.toThrow();
  });
});

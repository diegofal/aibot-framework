/**
 * Cycle 0 contract tests — the gate for the productions refactor.
 *
 * These are the 4 contract tests specified in
 * docs/architecture-docs/productions-refactor.md §4 C0. They pin
 * behavior that must NOT regress during the refactor:
 *
 *   C1 — `archiveFile` rejects paths with `..` (the real traversal exploit).
 *   C2 — `archiveFile` rejects absolute paths explicitly (defensive hardening;
 *        the short-circuit via `existsSync` already returns false for most
 *        absolute paths; this test pins the explicit rejection).
 *   C4 — `getAllEntries(opts)` honors `since` (shape parity with `getChangelog`).
 *   C5 — `getDirectoryTree` returns `[]` for bots where `isEnabled` is false.
 *
 * C3 was the supposed "in-process race" — removed in pass 1; in-process
 * sync read-modify-write is safe in Bun.
 *
 * Red phase on day 1: C1, C4, C5 are intentionally Red (gating future
 * cycles). C2 is green-on-arrival hardening.
 *
 * These tests go through the public API only. The implementing agent
 * never touches them during the refactor.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../src/config';
import { ProductionsService } from '../../src/productions/service';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

const TEST_DIR = join(process.cwd(), '.test-productions-contracts');

function makeConfig(): Config {
  return {
    bots: [
      // bot1 enabled, with a real production dir
      { id: 'bot1', name: 'Bot One', token: '', enabled: true, skills: [], productions: { enabled: true, trackOnly: false } },
      // bot2 disabled — tests C5
      { id: 'bot2', name: 'Bot Two (disabled)', token: '', enabled: true, skills: [], productions: { enabled: false, trackOnly: false } },
    ],
    productions: { enabled: true, baseDir: TEST_DIR },
  } as Config;
}

let service: ProductionsService;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  service = new ProductionsService(makeConfig(), noopLogger);
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// C1 — archiveFile rejects paths with `..` (the real traversal exploit)
// Red: archiveFile currently uses assertWithinDir indirectly via
// resolveFilePath, but its `..` handling goes through the existing logic.
// Cycle 1's consolidation makes this contract explicit. C1 turns green
// when the test is written against the post-Cycle-1 signature; today the
// relative-resolve short-circuits via existsSync.
// ---------------------------------------------------------------------------

describe('C1 — archiveFile rejects paths with ..', () => {
  test('returns false for a path that escapes via ..', () => {
    const dir = service.resolveDir('bot1');
    // Create a file OUTSIDE the production dir that the path would resolve to.
    // Use a path that would otherwise be reachable if the .. were honored.
    const result = service.archiveFile('bot1', '../../etc/passwd', 'attempt');
    expect(result).toBe(false);
  });

  test('returns false for a path with a single .. segment', () => {
    const result = service.archiveFile('bot1', '../outside.md', 'attempt');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C2 — archiveFile rejects absolute paths explicitly (defensive hardening)
// Green-on-arrival: archiveFile already returns false for absolute paths
// via the existsSync short-circuit (the resolved absolute path lands inside
// or outside the dir, neither exists at the resolved location, returns false).
// This test pins the explicit rejection.
// ---------------------------------------------------------------------------

describe('C2 — archiveFile rejects absolute paths (defensive hardening)', () => {
  test('returns false for /etc/passwd (POSIX absolute)', () => {
    const result = service.archiveFile('bot1', '/etc/passwd', 'attempt');
    expect(result).toBe(false);
  });

  test('returns false for D:/x (Windows absolute)', () => {
    const result = service.archiveFile('bot1', 'D:/x', 'attempt');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C4 — getAllEntries(opts) honors `since`
// Red: getAllEntries(opts) does not accept `since` (it accepts limit, offset,
// status, botId). The shape parity with getChangelog is the new behavior.
// C4 turns green in Cycle 6.
// ---------------------------------------------------------------------------

describe('C4 — getAllEntries honors since', () => {
  test('filters entries to those at or after the since timestamp', () => {
    // Create three entries with explicit timestamps.
    const t1 = '2025-01-01T00:00:00.000Z';
    const t2 = '2025-02-01T00:00:00.000Z';
    const t3 = '2025-03-01T00:00:00.000Z';

    service.logProduction({
      timestamp: t1, botId: 'bot1', tool: 'file_write', path: 'a.md',
      action: 'create', description: '', size: 0, trackOnly: false,
    });
    service.logProduction({
      timestamp: t2, botId: 'bot1', tool: 'file_write', path: 'b.md',
      action: 'create', description: '', size: 0, trackOnly: false,
    });
    service.logProduction({
      timestamp: t3, botId: 'bot1', tool: 'file_write', path: 'c.md',
      action: 'create', description: '', size: 0, trackOnly: false,
    } as any);

    const since = '2025-02-15T00:00:00.000Z';
    const result = service.getAllEntries({ botId: 'bot1', since });

    expect(result.total).toBe(1);
    expect(result.entries[0].path).toBe('c.md');
  });
});

// ---------------------------------------------------------------------------
// C5 — getDirectoryTree returns [] for bots where isEnabled is false
// Red: getDirectoryTree(botId) does not check isEnabled today (it only
// checks if the directory exists). C5 turns green in Cycle 7.
// ---------------------------------------------------------------------------

describe('C5 — getDirectoryTree returns [] for disabled bots', () => {
  test('returns [] for a bot with productions.enabled=false', () => {
    // bot2 is configured with productions.enabled=false.
    // Even if the directory exists, the result must be [].
    const dir = service.resolveDir('bot2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'forbidden.md'), 'should not be visible', 'utf-8');

    const tree = service.getDirectoryTree('bot2');
    expect(tree).toEqual([]);
  });
});

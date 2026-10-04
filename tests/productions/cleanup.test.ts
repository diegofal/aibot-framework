/**
 * Cycle 7 — cleanup.ts Red tests.
 *
 * Pinning the contract of src/productions/cleanup.ts. Per
 * docs/architecture-docs/productions-refactor.md §3.2 + §4.1 + §4.2,
 * this module extracts the auto-cleanup analysis logic from
 * ProductionsService.runCleanup.
 *
 * Module boundary:
 *   - Pure: analyzeCleanup(ctx, coherenceCheck, now) — scans the
 *     directory, returns a list of {path, reason} candidates.
 *   - Stateful: CleanupScheduler — owns the 1-hour throttle (lastCleanupAt).
 *   - No side effects: the facade composes the archive batch.
 *
 * Side effects (file moves, JSONL appends) stay on the facade (§4.1).
 * The throttle state and runCleanup move together (§4.2).
 *
 * Per-function coverage: each function gets its own describe block
 * with branch tests (per CLAUDE.md §"Flujo TDD obligatorio").
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeCleanup, CleanupScheduler } from '../../src/productions/cleanup';
import type { ProductionEntry } from '../../src/productions/types';

const TEMP_DIR = join(process.cwd(), '.test-productions-cleanup');

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

function entry(overrides: Partial<ProductionEntry>): ProductionEntry {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    timestamp: '2025-01-01T00:00:00.000Z',
    botId: 'bot1',
    tool: 'file_write',
    path: 'a.md',
    action: 'create',
    description: '',
    size: 0,
    trackOnly: false,
    ...overrides,
  } as ProductionEntry;
}

function writeChangelog(dir: string, entries: ProductionEntry[]): void {
  const changelogPath = join(dir, 'changelog.jsonl');
  const content = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  writeFileSync(changelogPath, content, 'utf-8');
}

function noCoherenceCheck(path: string): { coherent: boolean; issues: string[] } {
  return { coherent: true, issues: [] };
}

// ---------------------------------------------------------------------------
// analyzeCleanup
// ---------------------------------------------------------------------------

describe('analyzeCleanup', () => {
  test('returns empty array when changelog is empty', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    const result = analyzeCleanup({ dir, now: Date.now(), coherenceCheck: noCoherenceCheck });
    expect(result).toEqual([]);
  });

  test('flags tiny files (<50 bytes) that are tracked but not archived', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tiny.md'), 'x', 'utf-8'); // 1 byte
    writeChangelog(dir, [entry({ id: '1', path: 'tiny.md' })]);

    // Wait so the file is not within the 60s grace period.
    const now = Date.now() + 61_000;
    // Backdate the file mtime so the grace period passes.
    const past = (now - 120_000) / 1000;
    const { utimesSync } = require('node:fs');
    utimesSync(join(dir, 'tiny.md'), past, past);

    const result = analyzeCleanup({ dir, now, coherenceCheck: noCoherenceCheck });
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('tiny.md');
    expect(result[0].reason).toContain('too small');
  });

  test('flags duplicate files (SHA-256 collision)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    const content = 'duplicate content that is more than 50 bytes long — padded so size > 50';
    writeFileSync(join(dir, 'first.md'), content, 'utf-8');
    writeFileSync(join(dir, 'second.md'), content, 'utf-8');
    writeChangelog(dir, [
      entry({ id: '1', path: 'first.md' }),
      entry({ id: '2', path: 'second.md' }),
    ]);

    const now = Date.now() + 120_000;
    const past = (now - 120_000) / 1000;
    const { utimesSync } = require('node:fs');
    utimesSync(join(dir, 'first.md'), past, past);
    utimesSync(join(dir, 'second.md'), past, past);

    const result = analyzeCleanup({ dir, now, coherenceCheck: noCoherenceCheck });
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('second.md');
    expect(result[0].reason).toContain('duplicate of first.md');
  });

  // The original used to be whichever file readdirSync returned first:
  // alphabetical on NTFS, hash order on ext4 (the CI runner). It is now the
  // oldest copy, ties broken by path, whatever order the filesystem lists them in.
  test('keeps the oldest copy and flags the newer one, regardless of name order', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    const content = 'duplicate content that is more than 50 bytes long — padded so size > 50';
    writeFileSync(join(dir, 'a-copy.md'), content, 'utf-8');
    writeFileSync(join(dir, 'b-original.md'), content, 'utf-8');
    writeChangelog(dir, [
      entry({ id: '1', path: 'b-original.md' }),
      entry({ id: '2', path: 'a-copy.md' }),
    ]);

    const now = Date.now() + 600_000;
    const { utimesSync } = require('node:fs');
    const older = (now - 300_000) / 1000;
    const newer = (now - 120_000) / 1000;
    utimesSync(join(dir, 'b-original.md'), older, older);
    utimesSync(join(dir, 'a-copy.md'), newer, newer);

    const result = analyzeCleanup({ dir, now, coherenceCheck: noCoherenceCheck });
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('a-copy.md');
    expect(result[0].reason).toContain('duplicate of b-original.md');
  });

  test('flags incoherent .md files via the coherenceCheck callback', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rambling.md'), 'rambling content that is more than 50 bytes long — padded', 'utf-8');
    writeChangelog(dir, [entry({ id: '1', path: 'rambling.md' })]);

    const now = Date.now() + 120_000;
    const past = (now - 120_000) / 1000;
    const { utimesSync } = require('node:fs');
    utimesSync(join(dir, 'rambling.md'), past, past);

    const stubCheck = (p: string): { coherent: boolean; issues: string[] } => {
      if (p.endsWith('rambling.md')) return { coherent: false, issues: ['no structure'] };
      return { coherent: true, issues: [] };
    };

    const result = analyzeCleanup({ dir, now, coherenceCheck: stubCheck });
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('rambling.md');
    expect(result[0].reason).toContain('no structure');
  });

  test('skips approved files', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tiny.md'), 'x', 'utf-8');
    writeChangelog(dir, [
      entry({ id: '1', path: 'tiny.md', evaluation: { status: 'approved', evaluatedAt: 't' } }),
    ]);

    const now = Date.now() + 120_000;
    const past = (now - 120_000) / 1000;
    const { utimesSync } = require('node:fs');
    utimesSync(join(dir, 'tiny.md'), past, past);

    const result = analyzeCleanup({ dir, now, coherenceCheck: noCoherenceCheck });
    expect(result).toEqual([]);
  });

  test('skips files modified less than 60 seconds ago (grace period)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tiny.md'), 'x', 'utf-8');
    writeChangelog(dir, [entry({ id: '1', path: 'tiny.md' })]);

    // Now is essentially the file's mtime → grace period is active.
    const now = Date.now();
    const result = analyzeCleanup({ dir, now, coherenceCheck: noCoherenceCheck });
    expect(result).toEqual([]);
  });

  test('skips files in archived/ (already archived)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(join(dir, 'archived'), { recursive: true });
    writeFileSync(join(dir, 'archived', 'old.md'), 'x', 'utf-8');
    writeChangelog(dir, [entry({ id: '1', action: 'archive', path: 'archived/old.md' })]);

    const now = Date.now() + 120_000;
    const result = analyzeCleanup({ dir, now, coherenceCheck: noCoherenceCheck });
    expect(result).toEqual([]);
  });

  test('skips files in INDEX_EXCLUDES (changelog.jsonl, index.html)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'changelog.jsonl'), '{}', 'utf-8');
    writeFileSync(join(dir, 'index.html'), '<html>', 'utf-8');
    writeChangelog(dir, [entry({ id: '1' })]);

    const now = Date.now() + 120_000;
    const past = (now - 120_000) / 1000;
    const { utimesSync } = require('node:fs');
    utimesSync(join(dir, 'changelog.jsonl'), past, past);
    utimesSync(join(dir, 'index.html'), past, past);

    const result = analyzeCleanup({ dir, now, coherenceCheck: noCoherenceCheck });
    expect(result).toEqual([]);
  });

  test('skips untracked files (not in changelog)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tiny.md'), 'x', 'utf-8');
    writeChangelog(dir, [entry({ id: '1', path: 'other.md' })]);

    const now = Date.now() + 120_000;
    const past = (now - 120_000) / 1000;
    const { utimesSync } = require('node:fs');
    utimesSync(join(dir, 'tiny.md'), past, past);

    const result = analyzeCleanup({ dir, now, coherenceCheck: noCoherenceCheck });
    expect(result).toEqual([]);
  });

  test('walks nested directories', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'tiny.md'), 'x', 'utf-8');
    writeChangelog(dir, [entry({ id: '1', path: 'sub/tiny.md' })]);

    const now = Date.now() + 120_000;
    const past = (now - 120_000) / 1000;
    const { utimesSync } = require('node:fs');
    utimesSync(join(dir, 'sub', 'tiny.md'), past, past);

    const result = analyzeCleanup({ dir, now, coherenceCheck: noCoherenceCheck });
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('sub/tiny.md');
  });
});

// ---------------------------------------------------------------------------
// CleanupScheduler
// ---------------------------------------------------------------------------

describe('CleanupScheduler', () => {
  test('first call returns analysis; subsequent calls within 1 hour return null', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeChangelog(dir, [entry({ id: '1', path: 'tiny.md' })]);
    writeFileSync(join(dir, 'tiny.md'), 'x', 'utf-8');

    const scheduler = new CleanupScheduler();
    const now = Date.now() + 120_000;
    const past = (now - 120_000) / 1000;
    const { utimesSync } = require('node:fs');
    utimesSync(join(dir, 'tiny.md'), past, past);

    const first = scheduler.runCleanup('bot1', { dir, now, coherenceCheck: noCoherenceCheck });
    expect(first).not.toBeNull();
    expect(first).toHaveLength(1);

    const second = scheduler.runCleanup('bot1', { dir, now, coherenceCheck: noCoherenceCheck });
    expect(second).toBeNull();
  });

  test('separate bots have independent throttles', () => {
    const dir1 = join(TEMP_DIR, 'bot1');
    const dir2 = join(TEMP_DIR, 'bot2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeChangelog(dir1, [entry({ id: '1', path: 'b1.md' })]);
    writeChangelog(dir2, [entry({ id: '2', path: 'b2.md' })]);

    const scheduler = new CleanupScheduler();
    const now = Date.now() + 120_000;
    const past = (now - 120_000) / 1000;
    const { utimesSync } = require('node:fs');
    writeFileSync(join(dir1, 'b1.md'), 'x', 'utf-8');
    writeFileSync(join(dir2, 'b2.md'), 'x', 'utf-8');
    utimesSync(join(dir1, 'b1.md'), past, past);
    utimesSync(join(dir2, 'b2.md'), past, past);

    const first = scheduler.runCleanup('bot1', { dir: dir1, now, coherenceCheck: noCoherenceCheck });
    const second = scheduler.runCleanup('bot2', { dir: dir2, now, coherenceCheck: noCoherenceCheck });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  test('throttle allows a new run after >1 hour', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });

    const scheduler = new CleanupScheduler();
    const t1 = Date.now() + 120_000;
    const first = scheduler.runCleanup('bot1', { dir, now: t1, coherenceCheck: noCoherenceCheck });
    expect(first).toEqual([]);

    const t2 = t1 + 3600_001; // 1 hour + 1ms later
    const second = scheduler.runCleanup('bot1', { dir, now: t2, coherenceCheck: noCoherenceCheck });
    expect(second).not.toBeNull();
  });

  test('clear(botId) resets the throttle for one bot', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });

    const scheduler = new CleanupScheduler();
    const now = Date.now() + 120_000;
    scheduler.runCleanup('bot1', { dir, now, coherenceCheck: noCoherenceCheck });
    scheduler.clear('bot1');
    const second = scheduler.runCleanup('bot1', { dir, now, coherenceCheck: noCoherenceCheck });
    expect(second).not.toBeNull();
  });
});

/**
 * Cycle 5 — files.ts Red tests.
 *
 * Pinning the contract of src/productions/files.ts. Per
 * docs/architecture-docs/productions-refactor.md §4 C5 + C3, this
 * module extracts getFileContent, updateContent, getNextNumber,
 * renumberFile, and the new pure archiveFile.
 *
 * Pure functions on dir + file info. archiveFile is C3's pure form:
 *   - Validates the path via paths.ts.assertWithinDir
 *   - Moves the file to archived/<basename>
 *   - Returns { ok: true, entry: ProductionEntry } on success
 *   - Returns { ok: false } on missing file / path traversal / rename error
 *   - Does NOT append to JSONL, does NOT call rebuildIndex.
 *   - The facade (ProductionsService.archiveFile) is responsible for:
 *       appendEntry(dir, entry) + rebuildIndexPure(botId, dir, soulDir)
 *
 * The 4th parameter (skipRebuild) is REMOVED — it was a load-bearing
 * flag to break a recursive call cycle. With the C2 architecture the
 * cycle is broken structurally (modules are leaves).
 *
 * Per-function coverage: each function gets its own describe block
 * with branch tests (per CLAUDE.md §"Flujo TDD obligatorio").
 *
 * Cycle 5.1 writes these tests (Red). Cycle 5.3 creates the module
 * (Green). Cycle 5.4 wires service.ts to delegate to it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductionEntry } from '../../src/productions/types';
import {
  archiveFile,
  countFilesInDir,
  getFileContent,
  getNextNumber,
  renumberFile,
  updateContent,
} from '../../src/productions/files';

const TEMP_DIR = join(process.cwd(), '.test-productions-files');

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// archiveFile
// ---------------------------------------------------------------------------

describe('archiveFile', () => {
  test('returns {ok: true, entry} when file exists and moves it to archived/', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), 'original content', 'utf-8');

    const result = archiveFile({ dir }, 'report.md', 'superseded');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.tool).toBe('archive');
    expect(result.entry.action).toBe('archive');
    expect(result.entry.path).toBe('archived/report.md');
    expect(result.entry.archivedFrom).toBe('report.md');
    expect(result.entry.archiveReason).toBe('superseded');
    expect(result.entry.description).toBe('superseded');
    expect(result.entry.botId).toBe(''); // Pure function has no Config
    expect(result.entry.trackOnly).toBe(false);
    // Source file is gone, destination exists.
    expect(existsSync(join(dir, 'report.md'))).toBe(false);
    expect(existsSync(join(dir, 'archived/report.md'))).toBe(true);
  });

  test('returns {ok: false} when source file does not exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });

    const result = archiveFile({ dir }, 'nonexistent.md', 'no reason');
    expect(result.ok).toBe(false);
  });

  test('rejects path traversal (..)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });

    const result = archiveFile({ dir }, '../etc/passwd', 'attempt');
    expect(result.ok).toBe(false);
  });

  test('rejects absolute path', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });

    const result = archiveFile({ dir }, '/etc/passwd', 'attempt');
    expect(result.ok).toBe(false);
  });

  test('creates archived/ directory if it does not exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'to-archive.md'), 'content', 'utf-8');

    const result = archiveFile({ dir }, 'to-archive.md', 'reason');
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, 'archived'))).toBe(true);
    expect(existsSync(join(dir, 'archived/to-archive.md'))).toBe(true);
  });

  test('does NOT write to changelog (pure — facade composes persist)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), 'content', 'utf-8');

    archiveFile({ dir }, 'report.md', 'reason');

    // changelog.jsonl must not exist — facade appends the entry.
    expect(existsSync(join(dir, 'changelog.jsonl'))).toBe(false);
  });

  test('does NOT call rebuildIndex (pure — facade composes rebuild)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), 'content', 'utf-8');
    writeFileSync(join(dir, 'index.html'), '<old index>', 'utf-8');

    archiveFile({ dir }, 'report.md', 'reason');

    // index.html should not be regenerated.
    expect(readFileSync(join(dir, 'index.html'), 'utf-8')).toBe('<old index>');
  });

  test('generates a fresh entry id (randomUUID)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), 'a', 'utf-8');
    writeFileSync(join(dir, 'b.md'), 'b', 'utf-8');

    const r1 = archiveFile({ dir }, 'a.md', 'reason1');
    const r2 = archiveFile({ dir }, 'b.md', 'reason2');

    if (!r1.ok || !r2.ok) throw new Error('expected ok');
    expect(r1.entry.id).not.toBe(r2.entry.id);
    expect(r1.entry.id).toMatch(/^[0-9a-f-]{36}$/); // UUID shape
  });

  test('uses current ISO timestamp', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'r.md'), 'c', 'utf-8');

    const before = Date.now();
    const result = archiveFile({ dir }, 'r.md', 'reason');
    const after = Date.now();

    if (!result.ok) throw new Error('expected ok');
    const ts = new Date(result.entry.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// getFileContent
// ---------------------------------------------------------------------------

describe('getFileContent', () => {
  test('returns file content when file exists at relative path', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), 'the content', 'utf-8');

    const result = getFileContent({ dir }, 'report.md');
    expect(result.content).toBe('the content');
    expect(result.size).toBe(11);
  });

  test('returns null when file does not exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(getFileContent({ dir }, 'nope.md')).toBeNull();
  });

  test('returns null when path escapes dir (..)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(getFileContent({ dir }, '../outside.md')).toBeNull();
  });

  test('returns null for absolute path', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(getFileContent({ dir }, '/etc/passwd')).toBeNull();
  });

  test('handles nested directory', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(join(dir, 'subdir'), { recursive: true });
    writeFileSync(join(dir, 'subdir/nested.md'), 'nested content', 'utf-8');

    const result = getFileContent({ dir }, 'subdir/nested.md');
    expect(result?.content).toBe('nested content');
  });
});

// ---------------------------------------------------------------------------
// updateContent
// ---------------------------------------------------------------------------

describe('updateContent', () => {
  test('writes content to a relative path', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });

    const ok = updateContent({ dir }, 'report.md', 'new content');
    expect(ok).toBe(true);
    expect(readFileSync(join(dir, 'report.md'), 'utf-8')).toBe('new content');
  });

  test('overwrites existing file', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'r.md'), 'old', 'utf-8');

    const ok = updateContent({ dir }, 'r.md', 'new');
    expect(ok).toBe(true);
    expect(readFileSync(join(dir, 'r.md'), 'utf-8')).toBe('new');
  });

  test('returns false when path escapes dir (..)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(updateContent({ dir }, '../outside.md', 'evil')).toBe(false);
  });

  test('returns false for absolute path', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(updateContent({ dir }, '/etc/passwd', 'evil')).toBe(false);
  });

  test('creates parent directory if missing', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    // Note: subdir/ does not exist yet.

    const ok = updateContent({ dir }, 'subdir/nested.md', 'new content');
    expect(ok).toBe(true);
    expect(readFileSync(join(dir, 'subdir/nested.md'), 'utf-8')).toBe('new content');
  });
});

// ---------------------------------------------------------------------------
// getNextNumber
// ---------------------------------------------------------------------------

describe('getNextNumber', () => {
  test('returns "01" when target directory is empty', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(getNextNumber({ dir }, '')).toBe('01');
  });

  test('returns "01" when target directory does not exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(getNextNumber({ dir }, 'nope')).toBe('01');
  });

  test('returns next number after the highest existing numbered prefix', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '01_first.md'), 'a', 'utf-8');
    writeFileSync(join(dir, '02_second.md'), 'b', 'utf-8');

    expect(getNextNumber({ dir }, '')).toBe('03');
  });

  test('handles double-digit numbers (99 → 100 with 3-digit padding would be out of scope)', () => {
    // The plan says "^\d{2}_" — the regex matches exactly 2 digits. So 99 stays.
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '99_last.md'), 'x', 'utf-8');

    expect(getNextNumber({ dir }, '')).toBe('100');
    // The result is "100" — 3 digits, but the regex in renumberFile won't
    // match it. That's the documented behavior; the function returns a
    // number, renumberFile validates the prefix shape.
  });

  test('scans a subdirectory, not the root', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub/01_a.md'), 'a', 'utf-8');
    writeFileSync(join(dir, 'sub/02_b.md'), 'b', 'utf-8');
    // Root has no numbered files.
    expect(getNextNumber({ dir }, 'sub')).toBe('03');
    expect(getNextNumber({ dir }, '')).toBe('01');
  });

  test('ignores non-matching files', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plain.md'), 'a', 'utf-8');
    writeFileSync(join(dir, '01_numbered.md'), 'b', 'utf-8');

    expect(getNextNumber({ dir }, '')).toBe('02');
  });
});

// ---------------------------------------------------------------------------
// renumberFile
// ---------------------------------------------------------------------------

describe('renumberFile', () => {
  test('renames unnumbered file with next number', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plain.md'), 'content', 'utf-8');

    const newPath = renumberFile({ dir }, 'plain.md');
    expect(newPath).toBe('01_plain.md');
    expect(existsSync(join(dir, 'plain.md'))).toBe(false);
    expect(existsSync(join(dir, '01_plain.md'))).toBe(true);
  });

  test('returns unchanged path for already-numbered file', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '01_already.md'), 'c', 'utf-8');

    const newPath = renumberFile({ dir }, '01_already.md');
    expect(newPath).toBe('01_already.md');
  });

  test('returns unchanged path for excluded file (changelog.jsonl)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'changelog.jsonl'), 'log', 'utf-8');

    const newPath = renumberFile({ dir }, 'changelog.jsonl');
    expect(newPath).toBe('changelog.jsonl');
  });

  test('returns unchanged path for missing source file', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });

    const newPath = renumberFile({ dir }, 'nonexistent.md');
    expect(newPath).toBe('nonexistent.md');
  });

  test('renames file in nested directory with the dir-scoped number', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub/plain.md'), 'c', 'utf-8');
    writeFileSync(join(dir, 'sub/01_existing.md'), 'e', 'utf-8');

    const newPath = renumberFile({ dir }, 'sub/plain.md');
    expect(newPath).toBe('sub/02_plain.md');
    expect(existsSync(join(dir, 'sub/02_plain.md'))).toBe(true);
  });

  test('increments when other numbered files exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '01_a.md'), 'a', 'utf-8');
    writeFileSync(join(dir, 'plain.md'), 'b', 'utf-8');

    const newPath = renumberFile({ dir }, 'plain.md');
    expect(newPath).toBe('02_plain.md');
  });

  // review-4 R1: defense-in-depth traversal guard.
  test('returns unchanged path for path traversal (..)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(renumberFile({ dir }, '../escape.md')).toBe('../escape.md');
  });

  test('returns unchanged path for absolute path', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(renumberFile({ dir }, '/etc/passwd')).toBe('/etc/passwd');
  });
});

describe('getNextNumber traversal guard (review-4 R1)', () => {
  test('returns "01" for path traversal (..)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(getNextNumber({ dir }, '..')).toBe('01');
  });

  test('returns "01" for nested traversal', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(getNextNumber({ dir }, '../escape')).toBe('01');
  });

  test('returns "01" for absolute path', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(getNextNumber({ dir }, '/etc')).toBe('01');
  });
});

describe('countFilesInDir', () => {
  test('returns 0 for missing directory', () => {
    expect(countFilesInDir(join(TEMP_DIR, 'missing'))).toBe(0);
  });

  test('returns 0 for empty directory', () => {
    const dir = join(TEMP_DIR, 'empty');
    mkdirSync(dir, { recursive: true });
    expect(countFilesInDir(dir)).toBe(0);
  });

  test('counts files at the top level', () => {
    const dir = join(TEMP_DIR, 'flat');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), 'x', 'utf-8');
    writeFileSync(join(dir, 'b.md'), 'y', 'utf-8');
    expect(countFilesInDir(dir)).toBe(2);
  });

  test('counts files recursively', () => {
    const dir = join(TEMP_DIR, 'nested');
    mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'a.md'), 'x', 'utf-8');
    writeFileSync(join(dir, 'sub', 'b.md'), 'y', 'utf-8');
    writeFileSync(join(dir, 'sub', 'deep', 'c.md'), 'z', 'utf-8');
    expect(countFilesInDir(dir)).toBe(3);
  });

  test('does not count subdirectories, only files', () => {
    const dir = join(TEMP_DIR, 'mixed');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.md'), 'x', 'utf-8');
    expect(countFilesInDir(dir)).toBe(1);
  });
});

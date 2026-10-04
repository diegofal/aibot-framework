/**
 * Cycle 0.5 Red matrix — assertWithinDir Red tests.
 *
 * The 11 rows in this file are the Red matrix from the plan's Cycle 0.5
 * (docs/architecture-docs/productions-refactor.md §4 C0.5). During
 * Cycle 0.5 `assertWithinDir` lives as a private module-level function in
 * service.ts, so the tests observe behavior through the public API
 * (updateContent, getFileContent, deleteByPath) rather than calling it
 * directly. Cycle 1 will export it from paths.ts and the tests will be
 * ported to a unit-test form there.
 *
 * Currently (Red phase): all 11 rows below fail because the existing
 * implementation uses `dir + '/'` for containment (which fails on
 * Windows) and `relativePath.includes('..')` for `deleteByPath` (which
 * over-rejects filenames like `my..file.md`). The Green step in
 * Cycle 0.5 introduces `assertWithinDir` with the corrected code.
 *
 * The 6 pre-existing Windows failures (tests/productions.test.ts:
 *   rewritePath > rewrites path to productions dir
 *   updateContent > writes content to file with absolute path
 *   updateContent > writes content to file with relative path
 *   getFileContent > reads file content for production entry with absolute path
 *   getFileContent > reads file content for production entry with relative path
 *   path traversal protection > updateContent allows paths within production dir
 * ) must also be accounted for by the Green step.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const TEST_DIR = join(process.cwd(), '.test-productions-assert');

function makeConfig(): Config {
  return {
    bots: [
      { id: 'bot1', name: 'Bot One', token: '', enabled: true, skills: [], productions: { enabled: true, trackOnly: false } },
      { id: 'bot2', name: 'Bot Two', token: '', enabled: true, skills: [], productions: { enabled: true, trackOnly: true } },
    ],
    productions: { enabled: true, baseDir: TEST_DIR },
  } as Config;
}

function makeEntry(botId: string, path: string) {
  return service.logProduction({
    timestamp: new Date().toISOString(),
    botId,
    tool: 'file_write',
    path,
    action: 'create',
    description: 'red-matrix entry',
    size: 0,
    trackOnly: false,
  });
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
// ACCEPTED row — the basic case
// ---------------------------------------------------------------------------

describe('Cycle 0.5 Red matrix — accepted paths', () => {
  test('safe.md is accepted', () => {
    const dir = service.resolveDir('bot1');
    writeFileSync(join(dir, 'safe.md'), 'old', 'utf-8');
    const entry = makeEntry('bot1', 'safe.md');
    expect(service.updateContent('bot1', entry.id, 'new')).toBe(true);
    expect(service.getFileContent('bot1', entry.id)).toBe('new');
  });

  test('..file.md is accepted (filename begins with `..` but is a single segment)', () => {
    const dir = service.resolveDir('bot1');
    writeFileSync(join(dir, '..file.md'), 'old', 'utf-8');
    const entry = makeEntry('bot1', '..file.md');
    expect(service.updateContent('bot1', entry.id, 'new')).toBe(true);
    expect(service.getFileContent('bot1', entry.id)).toBe('new');
  });

  test('my..file.md is accepted (old includes("..") check in deleteByPath was over-broad)', () => {
    const dir = service.resolveDir('bot1');
    writeFileSync(join(dir, 'my..file.md'), 'old', 'utf-8');
    const entry = makeEntry('bot1', 'my..file.md');
    expect(service.updateContent('bot1', entry.id, 'new')).toBe(true);
    expect(service.getFileContent('bot1', entry.id)).toBe('new');
  });

  test('a/../b.md is accepted (resolves to b.md in-dir)', () => {
    const dir = service.resolveDir('bot1');
    writeFileSync(join(dir, 'b.md'), 'old', 'utf-8');
    const entry = makeEntry('bot1', 'a/../b.md');
    expect(service.updateContent('bot1', entry.id, 'new')).toBe(true);
    expect(service.getFileContent('bot1', entry.id)).toBe('new');
  });

  test('empty string is accepted (the dir itself)', () => {
    // The empty path is the dir itself. No file operation is expected; the
    // entry is created; read returns null (no file at the dir path).
    const entry = makeEntry('bot1', '');
    expect(entry.id).toBeDefined();
    expect(service.getFileContent('bot1', entry.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REJECTED rows
// ---------------------------------------------------------------------------

describe('Cycle 0.5 Red matrix — rejected paths', () => {
  test('../outside.md is rejected (.. is a path segment)', () => {
    const dir = service.resolveDir('bot1');
    writeFileSync(join(dir, 'outside.md'), 'old', 'utf-8');
    const entry = makeEntry('bot1', '../outside.md');
    expect(service.updateContent('bot1', entry.id, 'new')).toBe(false);
    expect(service.getFileContent('bot1', entry.id)).toBeNull();
  });

  test('../../etc/passwd is rejected (leading .. segments)', () => {
    const entry = makeEntry('bot1', '../../etc/passwd');
    expect(service.updateContent('bot1', entry.id, 'new')).toBe(false);
    expect(service.getFileContent('bot1', entry.id)).toBeNull();
  });

  test('/etc/passwd is rejected (absolute Linux path)', () => {
    // Note: the pre-existing `updateContent` test for "absolute path"
    // asserts the same intent. The new Red matrix row is the explicit
    // pin from Cycle 0.5.
    if (existsSync('/tmp/evil-file.txt')) rmSync('/tmp/evil-file.txt');
    const entry = makeEntry('bot1', '/etc/passwd');
    expect(service.updateContent('bot1', entry.id, 'new')).toBe(false);
    expect(service.getFileContent('bot1', entry.id)).toBeNull();
  });

  test('D:/x is rejected (absolute Windows path)', () => {
    const entry = makeEntry('bot1', 'D:/x');
    expect(service.updateContent('bot1', entry.id, 'new')).toBe(false);
    expect(service.getFileContent('bot1', entry.id)).toBeNull();
  });

  test('D:\\prod\\bot10\\safe.md is rejected (absolute Windows path with drive)', () => {
    const entry = makeEntry('bot1', 'D:\\prod\\bot10\\safe.md');
    expect(service.updateContent('bot1', entry.id, 'new')).toBe(false);
    expect(service.getFileContent('bot1', entry.id)).toBeNull();
  });

  test("../bot10/safe.md is rejected (the prefix-sibling bug getFileContentByPath had)", () => {
    // This is the bug at service.ts:1515: startsWith(dir) matched
    // '../bot10/safe.md' against 'D:\\prod\\bot1' because there was no
    // trailing separator. The new check rejects it because the resolved
    // relative path starts with '../bot10/' rather than being inside
    // the directory.
    const dir = service.resolveDir('bot1');
    writeFileSync(join(dir, 'safe.md'), 'old', 'utf-8');
    const entry = makeEntry('bot1', '../bot10/safe.md');
    expect(service.updateContent('bot1', entry.id, 'new')).toBe(false);
    expect(service.getFileContent('bot1', entry.id)).toBeNull();
  });
});

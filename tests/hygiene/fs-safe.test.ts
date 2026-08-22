import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TrashBatch,
  assertWithinRoots,
  backupFile,
  isWithinRoot,
  trashBatchStamp,
} from '../../src/hygiene/fs-safe';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

let dir: string;

beforeEach(() => {
  dir = createTempDir('hygiene-fs');
});

afterEach(() => {
  removeTempDir(dir);
});

describe('isWithinRoot', () => {
  test('accepts the root itself and descendants', () => {
    expect(isWithinRoot(dir, dir)).toBe(true);
    expect(isWithinRoot(join(dir, 'a', 'b.md'), dir)).toBe(true);
  });

  test('rejects parents, siblings and prefix-siblings', () => {
    expect(isWithinRoot(join(dir, '..'), dir)).toBe(false);
    expect(isWithinRoot(`${dir}-sibling/file`, dir)).toBe(false);
    expect(isWithinRoot(join(dir, '..', 'other'), dir)).toBe(false);
  });
});

describe('assertWithinRoots', () => {
  test('passes when inside any root', () => {
    expect(() => assertWithinRoots(join(dir, 'x'), [join(dir, 'nope'), dir])).not.toThrow();
  });

  test('throws when outside every root', () => {
    expect(() => assertWithinRoots(join(dir, '..', 'escape'), [dir])).toThrow(/outside/);
  });
});

describe('backupFile', () => {
  test('copies into .versions/<name>.<ISO>.bak and returns the path', () => {
    const file = join(dir, 'GOALS.md');
    writeFileSync(file, 'hello');
    const backup = backupFile(file, noopLogger);
    expect(backup).not.toBeNull();
    expect(backup!.startsWith(join(dir, '.versions'))).toBe(true);
    expect(backup!).toMatch(/GOALS\.md\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?\.bak$/);
    expect(readFileSync(backup!, 'utf-8')).toBe('hello');
  });

  test('returns null for a missing file and writes nothing', () => {
    expect(backupFile(join(dir, 'missing.md'), noopLogger)).toBeNull();
    expect(existsSync(join(dir, '.versions'))).toBe(false);
  });

  test('does not overwrite a backup taken in the same second', () => {
    const file = join(dir, 'SOUL.md');
    writeFileSync(file, 'v1');
    const first = backupFile(file, noopLogger);
    writeFileSync(file, 'v2');
    const second = backupFile(file, noopLogger);
    expect(first).not.toBe(second);
    expect(readFileSync(first!, 'utf-8')).toBe('v1');
    expect(readFileSync(second!, 'utf-8')).toBe('v2');
    expect(readdirSync(join(dir, '.versions')).length).toBe(2);
  });
});

describe('TrashBatch', () => {
  test('stamp is filesystem safe', () => {
    expect(trashBatchStamp(new Date('2026-08-21T10:11:12.345Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/
    );
  });

  test('moves a directory under _trash/<stamp>/<relative path> and writes manifest', () => {
    const dataDir = join(dir, 'data');
    const orphan = join(dataDir, 'karma', 'ghost');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'events.jsonl'), '{}\n');

    const batch = new TrashBatch(dataDir, [dataDir], new Date('2026-08-21T10:11:12Z'), noopLogger);
    const dest = batch.move(orphan, 'karma/ghost', 'orphan-karma-dir');
    batch.finalize();

    expect(existsSync(orphan)).toBe(false);
    expect(dest).toBe(join(dataDir, '_trash', '2026-08-21T10-11-12', 'karma', 'ghost'));
    expect(readFileSync(join(dest, 'events.jsonl'), 'utf-8')).toBe('{}\n');

    const manifest = JSON.parse(
      readFileSync(join(dataDir, '_trash', '2026-08-21T10-11-12', 'manifest.json'), 'utf-8')
    );
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({
      from: orphan,
      to: dest,
      relativePath: 'karma/ghost',
      reason: 'orphan-karma-dir',
    });
  });

  test('refuses to move anything outside the allowed roots', () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'x');
    const batch = new TrashBatch(dataDir, [dataDir], new Date(), noopLogger);
    expect(() => batch.move(outside, 'outside.txt', 'test')).toThrow(/outside/);
    expect(existsSync(outside)).toBe(true);
  });

  test('does not write a manifest when nothing was moved', () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const batch = new TrashBatch(dataDir, [dataDir], new Date(), noopLogger);
    batch.finalize();
    expect(existsSync(join(dataDir, '_trash'))).toBe(false);
  });

  test('rejects relative paths that climb out of the batch dir', () => {
    const dataDir = join(dir, 'data');
    const victim = join(dataDir, 'karma', 'x');
    mkdirSync(victim, { recursive: true });
    const batch = new TrashBatch(dataDir, [dataDir], new Date(), noopLogger);
    expect(() => batch.move(victim, '../../x', 'test')).toThrow(/outside/);
  });
});

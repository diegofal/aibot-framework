import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dataDirOf, parseResetMindArgs } from '../../../scripts/watcher/reset-mind';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('parseResetMindArgs', () => {
  test('dry run by default with the container config path', () => {
    expect(parseResetMindArgs([])).toEqual({ apply: false, configPath: './config/config.json' });
  });

  test('--apply, --restore and --config', () => {
    expect(parseResetMindArgs(['--apply', '--config', 'c.json'])).toEqual({
      apply: true,
      configPath: 'c.json',
    });
    expect(parseResetMindArgs(['--restore', '/app/data/_trash/x'])).toMatchObject({
      apply: false,
      restore: '/app/data/_trash/x',
    });
  });
});

describe('dataDirOf', () => {
  test('reads paths.data, defaulting to ./data', () => {
    root = mkdtempSync(join(tmpdir(), 'reset-mind-'));
    const withData = join(root, 'a.json');
    writeFileSync(withData, JSON.stringify({ paths: { data: '/app/data' } }));
    expect(dataDirOf(withData)).toBe(resolve('/app/data'));
    const without = join(root, 'b.json');
    writeFileSync(without, '{}');
    expect(dataDirOf(without)).toBe(resolve('./data'));
  });
});

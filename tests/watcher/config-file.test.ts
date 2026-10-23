import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../src/config';
import {
  applyWatcherConfigPatch,
  parseWatcherConfigPatch,
  persistWatcherConfigPatch,
  tierSwitches,
} from '../../src/watcher/config-file';
import { WATCHER_DEFAULTS } from '../../src/watcher/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-cfgfile-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseWatcherConfigPatch', () => {
  test('keeps only the given fields', () => {
    expect(parseWatcherConfigPatch({ notice: { enabled: true } })).toEqual({
      ok: true,
      patch: { notice: { enabled: true } },
    });
    expect(parseWatcherConfigPatch({ integrate: { maxPerDay: 0 } })).toEqual({
      ok: true,
      patch: { integrate: { maxPerDay: 0 } },
    });
  });
  test('an empty tier object is nothing to change', () => {
    expect(parseWatcherConfigPatch({ notice: {} }).ok).toBe(false);
  });
});

describe('persistWatcherConfigPatch', () => {
  test('an unreadable file is a 500 and nothing is written', () => {
    const path = join(dir, 'missing.json');
    const res = persistWatcherConfigPatch(path, { notice: { enabled: true } });
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(existsSync(path)).toBe(false);
  });
  test('a file that is not JSON is a 500 and stays as is', () => {
    const path = join(dir, 'c.json');
    writeFileSync(path, '{nope');
    expect(persistWatcherConfigPatch(path, { notice: { enabled: true } })).toMatchObject({
      ok: false,
      status: 500,
    });
    expect(readFileSync(path, 'utf-8')).toBe('{nope');
  });
});

describe('applyWatcherConfigPatch', () => {
  test('replaces the tier objects, never mutating WATCHER_DEFAULTS', () => {
    const config = { watcher: { ...WATCHER_DEFAULTS, enabled: true } } as unknown as Config;
    const next = applyWatcherConfigPatch(config, { notice: { enabled: true, maxPerDay: 7 } });
    expect(next.notice.enabled).toBe(true);
    expect(next.notice.maxPerDay).toBe(7);
    expect(next.notice.model).toBe(WATCHER_DEFAULTS.notice.model);
    expect(config.watcher).toBe(next);
    expect(WATCHER_DEFAULTS.notice.enabled).toBe(false);
    expect(WATCHER_DEFAULTS.notice.maxPerDay).toBe(288);
  });
});

describe('tierSwitches', () => {
  test('the enabled switch and daily cap of each tier', () => {
    expect(tierSwitches(WATCHER_DEFAULTS)).toEqual({
      notice: { enabled: false, maxPerDay: 288 },
      integrate: { enabled: false, maxPerDay: 24 },
    });
  });
});

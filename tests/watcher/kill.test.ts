import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  WATCHER_KILL_ENV,
  WATCHER_KILL_FILE,
  isKillValue,
  killSentinelPath,
  readKillSwitch,
} from '../../src/watcher/kill';
import { watcherDir } from '../../src/watcher/paths';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watcher-kill-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('kill switch (C1)', () => {
  test('the sentinel is <paths.data>/watcher-kill, outside the watcher dir', () => {
    const config = { paths: { data: join(root, 'data') } } as never;
    const path = killSentinelPath(config);
    expect(path).toBe(join(root, 'data', WATCHER_KILL_FILE));
    // Everything the watcher writes lives under `<data>/watcher/`; the sentinel is not there
    // (a path prefix, not a string prefix: `watcher-kill` starts with `watcher`).
    expect(relative(watcherDir(config), path).startsWith('..')).toBe(true);
  });

  test('the sentinel defaults to ./data like the watcher dir', () => {
    expect(killSentinelPath({ paths: {} } as never)).toBe(join('./data', WATCHER_KILL_FILE));
  });

  test('not killed with no env and no sentinel', () => {
    expect(readKillSwitch({ env: {}, sentinelPath: join(root, 'watcher-kill') })).toEqual({
      killed: false,
    });
  });

  test('env values 1/true/yes/on kill, case-insensitive and trimmed', () => {
    for (const v of ['1', 'true', 'TRUE', 'Yes', ' on ', 'ON']) {
      expect(
        readKillSwitch({ env: { [WATCHER_KILL_ENV]: v }, sentinelPath: join(root, 'none') })
      ).toEqual({ killed: true, source: 'env' });
    }
  });

  test('other env values do not kill', () => {
    for (const v of ['', '0', 'false', 'no', 'off', 'kill', '2']) {
      expect(isKillValue(v)).toBe(false);
      expect(
        readKillSwitch({ env: { [WATCHER_KILL_ENV]: v }, sentinelPath: join(root, 'none') }).killed
      ).toBe(false);
    }
    expect(isKillValue(undefined)).toBe(false);
  });

  test('the sentinel file kills, whatever it contains', () => {
    const path = join(root, 'watcher-kill');
    writeFileSync(path, '');
    expect(readKillSwitch({ env: {}, sentinelPath: path })).toEqual({
      killed: true,
      source: 'file',
    });
  });

  test('env wins when both are on', () => {
    const path = join(root, 'watcher-kill');
    writeFileSync(path, 'x');
    expect(readKillSwitch({ env: { [WATCHER_KILL_ENV]: '1' }, sentinelPath: path })).toEqual({
      killed: true,
      source: 'env',
    });
  });

  test('a stat error is not a kill by file, but the env still counts', () => {
    const boom = () => {
      throw new Error('EACCES');
    };
    expect(readKillSwitch({ env: {}, sentinelPath: 'x', exists: boom })).toEqual({
      killed: false,
    });
    expect(
      readKillSwitch({ env: { [WATCHER_KILL_ENV]: 'yes' }, sentinelPath: 'x', exists: boom })
    ).toEqual({ killed: true, source: 'env' });
  });

  test('reads process.env by default', () => {
    const before = process.env[WATCHER_KILL_ENV];
    try {
      process.env[WATCHER_KILL_ENV] = 'on';
      expect(readKillSwitch({ sentinelPath: join(root, 'none') })).toEqual({
        killed: true,
        source: 'env',
      });
    } finally {
      if (before === undefined) delete process.env[WATCHER_KILL_ENV];
      else process.env[WATCHER_KILL_ENV] = before;
    }
  });

  test('an env object whose read throws never throws out', () => {
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error('no');
        },
      }
    ) as NodeJS.ProcessEnv;
    expect(readKillSwitch({ env, sentinelPath: join(root, 'none') })).toEqual({ killed: false });
  });
});

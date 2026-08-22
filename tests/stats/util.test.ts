import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dateKey,
  listDirSafe,
  median,
  parseWindow,
  ratio,
  readJsonSafe,
  readJsonlSafe,
  statSizeSafe,
  tailText,
  toIso,
  windowToMs,
} from '../../src/stats/util';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

let dir: string;
beforeEach(() => {
  dir = createTempDir('stats-util');
});
afterEach(() => removeTempDir(dir));

describe('parseWindow / windowToMs', () => {
  it('defaults to 7d and accepts the three known windows', () => {
    expect(parseWindow(undefined)).toBe('7d');
    expect(parseWindow('bogus')).toBe('7d');
    expect(parseWindow('24h')).toBe('24h');
    expect(parseWindow('30d')).toBe('30d');
  });
  it('maps windows to milliseconds', () => {
    expect(windowToMs('24h')).toBe(86_400_000);
    expect(windowToMs('7d')).toBe(7 * 86_400_000);
    expect(windowToMs('30d')).toBe(30 * 86_400_000);
  });
});

describe('readJsonlSafe', () => {
  it('returns [] for a missing file', () => {
    expect(readJsonlSafe(join(dir, 'nope.jsonl'))).toEqual([]);
  });
  it('skips malformed lines and blank lines', () => {
    const p = join(dir, 'a.jsonl');
    writeFileSync(p, '{"a":1}\n\nnot json\n{"a":2}\n');
    expect(readJsonlSafe<{ a: number }>(p)).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('readJsonSafe', () => {
  it('returns null for missing or malformed files', () => {
    expect(readJsonSafe(join(dir, 'x.json'))).toBeNull();
    writeFileSync(join(dir, 'bad.json'), '{');
    expect(readJsonSafe(join(dir, 'bad.json'))).toBeNull();
  });
  it('parses a valid file', () => {
    writeFileSync(join(dir, 'ok.json'), '{"k":true}');
    expect(readJsonSafe<{ k: boolean }>(join(dir, 'ok.json'))).toEqual({ k: true });
  });
});

describe('listDirSafe / statSizeSafe', () => {
  it('returns [] / 0 for missing paths', () => {
    expect(listDirSafe(join(dir, 'missing'))).toEqual([]);
    expect(statSizeSafe(join(dir, 'missing.txt'))).toBe(0);
  });
  it('lists entries and reports sizes', () => {
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'f.txt'), 'hello');
    expect(listDirSafe(join(dir, 'd'))).toEqual(['f.txt']);
    expect(statSizeSafe(join(dir, 'd', 'f.txt'))).toBe(5);
  });
});

describe('tailText', () => {
  it('returns the last N bytes of a file, dropping a partial first line', () => {
    const p = join(dir, 'log.txt');
    writeFileSync(p, 'line1\nline2\nline3\n');
    expect(tailText(p, 9)).toBe('line3\n');
    expect(tailText(p, 1000)).toBe('line1\nline2\nline3\n');
  });
  it('returns empty string for a missing file', () => {
    expect(tailText(join(dir, 'none'), 10)).toBe('');
  });
});

describe('scalar helpers', () => {
  it('toIso handles ms, ISO strings and null', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso(0)).toBeNull();
    expect(toIso(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(toIso('2024-01-01T00:00:00.000Z')).toBe('2024-01-01T00:00:00.000Z');
    expect(toIso('garbage')).toBeNull();
  });
  it('ratio guards division by zero', () => {
    expect(ratio(0, 0)).toBe(0);
    expect(ratio(1, 4)).toBe(0.25);
  });
  it('median handles empty, odd and even lists', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('dateKey yields YYYY-MM-DD in UTC', () => {
    expect(dateKey(Date.UTC(2026, 1, 3, 12))).toBe('2026-02-03');
  });
});

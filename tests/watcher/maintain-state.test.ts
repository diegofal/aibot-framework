import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAINTAIN_EVERY_MS,
  maintenanceDue,
  readLastMaintainAt,
  writeLastMaintainAt,
} from '../../src/watcher/maintain-state';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watcher-maintain-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('maintain state', () => {
  test('round-trips lastMaintainAt; missing or broken reads undefined', () => {
    const file = join(root, 'w', 'maintain.json');
    expect(readLastMaintainAt(file)).toBeUndefined();
    writeLastMaintainAt(file, '2026-10-26T10:00:00.000Z');
    expect(readLastMaintainAt(file)).toBe(Date.parse('2026-10-26T10:00:00.000Z'));
    writeFileSync(file, '{');
    expect(readLastMaintainAt(file)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ lastMaintainAt: 'yesterday-ish' }));
    expect(readLastMaintainAt(file)).toBeUndefined();
  });

  test('due when never run or a day or more ago', () => {
    const now = Date.parse('2026-10-26T10:00:00Z');
    expect(maintenanceDue(undefined, now)).toBe(true);
    expect(maintenanceDue(now - MAINTAIN_EVERY_MS, now)).toBe(true);
    expect(maintenanceDue(now - MAINTAIN_EVERY_MS + 1, now)).toBe(false);
    expect(maintenanceDue(now, now)).toBe(false);
  });
});

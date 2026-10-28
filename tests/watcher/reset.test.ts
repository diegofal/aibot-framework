import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMindReset,
  planMindReset,
  restoreMindReset,
  watcherWrittenWithin,
} from '../../src/watcher/reset';

let root: string;
let dataDir: string;
let configDir: string;
const NOW = Date.parse('2026-10-28T03:00:00Z');

function bots(): Array<{ id: string; enabled?: boolean; name: string }> {
  return JSON.parse(readFileSync(join(configDir, 'bots.json'), 'utf-8'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mind-reset-'));
  dataDir = join(root, 'data');
  configDir = join(root, 'config');
  mkdirSync(join(dataDir, 'watcher', 'log'), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(dataDir, 'watcher', 'neurons.jsonl'), '{"id":"n-1"}\n');
  writeFileSync(join(dataDir, 'watcher', 'log', '2026-10-27.jsonl'), '{}\n');
  writeFileSync(
    join(configDir, 'bots.json'),
    JSON.stringify([
      { id: 'a', name: 'A', enabled: true, token: '${A_TOKEN}' },
      { id: 'b', name: 'B', enabled: false },
      { id: 'c', name: 'C' },
    ])
  );
  // Files are old: the process that wrote them is gone.
  const old = new Date(NOW - 10 * 60_000);
  for (const f of ['neurons.jsonl', 'log/2026-10-27.jsonl', 'log', ''])
    utimesSync(join(dataDir, 'watcher', f), old, old);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('planMindReset', () => {
  test('lists the bots to turn off, the watcher dir and where it goes', () => {
    const plan = planMindReset({ dataDir, configDir, nowMs: NOW });
    expect(plan.enabledBots).toEqual(['a', 'c']);
    expect(plan.watcherExists).toBe(true);
    expect(plan.watcherFiles).toBe(2);
    expect(plan.archiveDir).toBe(join(dataDir, '_trash', '2026-10-28T03-00-00-000Z-mind-reset'));
  });

  test('no watcher dir: nothing to archive, bots still listed', () => {
    rmSync(join(dataDir, 'watcher'), { recursive: true });
    const plan = planMindReset({ dataDir, configDir, nowMs: NOW });
    expect(plan.watcherExists).toBe(false);
    expect(plan.enabledBots).toEqual(['a', 'c']);
  });
});

describe('watcherWrittenWithin', () => {
  test('true when a file changed inside the window (the process is still running)', () => {
    writeFileSync(join(dataDir, 'watcher', 'log', '2026-10-28.jsonl'), '{}\n');
    expect(watcherWrittenWithin(join(dataDir, 'watcher'), Date.now(), 60_000)).toBe(true);
  });

  test('false when every file is older than the window', () => {
    expect(watcherWrittenWithin(join(dataDir, 'watcher'), NOW, 60_000)).toBe(false);
  });
});

describe('applyMindReset', () => {
  test('turns every bot off, keeps every other field, archives the watcher dir with a manifest', () => {
    const plan = planMindReset({ dataDir, configDir, nowMs: NOW });
    const result = applyMindReset(plan, { nowMs: NOW });
    expect(result.disabled).toEqual(['a', 'c']);
    expect(bots().map((b) => b.enabled)).toEqual([false, false, false]);
    expect(bots()[0]).toMatchObject({ id: 'a', name: 'A', token: '${A_TOKEN}' });
    expect(existsSync(join(dataDir, 'watcher'))).toBe(false);
    expect(existsSync(join(plan.archiveDir, 'watcher', 'neurons.jsonl'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(plan.archiveDir, 'manifest.json'), 'utf-8'));
    expect(manifest).toMatchObject({
      kind: 'mind-reset',
      at: '2026-10-28T03:00:00.000Z',
      previouslyEnabled: ['a', 'c'],
      watcherArchived: true,
    });
  });

  test('refuses when the watcher dir was written in the last minute', () => {
    writeFileSync(join(dataDir, 'watcher', 'buffer.json'), '[]');
    const plan = planMindReset({ dataDir, configDir, nowMs: Date.now() });
    expect(() => applyMindReset(plan, { nowMs: Date.now() })).toThrow(/still running/);
    expect(bots()[0].enabled).toBe(true);
    expect(existsSync(join(dataDir, 'watcher'))).toBe(true);
  });

  test('keeps the bots.json shape when it is an object with a bots array', () => {
    writeFileSync(
      join(configDir, 'bots.json'),
      JSON.stringify({ bots: [{ id: 'a', enabled: true }] })
    );
    const plan = planMindReset({ dataDir, configDir, nowMs: NOW });
    applyMindReset(plan, { nowMs: NOW });
    const raw = JSON.parse(readFileSync(join(configDir, 'bots.json'), 'utf-8'));
    expect(raw).toEqual({ bots: [{ id: 'a', enabled: false }] });
  });
});

describe('restoreMindReset', () => {
  test('moves the watcher back and turns the same bots on again', () => {
    const plan = planMindReset({ dataDir, configDir, nowMs: NOW });
    applyMindReset(plan, { nowMs: NOW });
    const result = restoreMindReset(plan.archiveDir, { dataDir, configDir, nowMs: NOW + 1000 });
    expect(result.reenabled).toEqual(['a', 'c']);
    expect(bots().map((b) => b.enabled)).toEqual([true, false, true]);
    expect(existsSync(join(dataDir, 'watcher', 'neurons.jsonl'))).toBe(true);
    expect(existsSync(join(plan.archiveDir, 'watcher'))).toBe(false);
  });

  test('a fresh watcher dir made after the reset is set aside, not overwritten', () => {
    const plan = planMindReset({ dataDir, configDir, nowMs: NOW });
    applyMindReset(plan, { nowMs: NOW });
    mkdirSync(join(dataDir, 'watcher'), { recursive: true });
    writeFileSync(join(dataDir, 'watcher', 'neurons.jsonl'), '{"id":"n-new"}\n');
    const old = new Date(NOW - 10 * 60_000);
    utimesSync(join(dataDir, 'watcher', 'neurons.jsonl'), old, old);
    utimesSync(join(dataDir, 'watcher'), old, old);
    const result = restoreMindReset(plan.archiveDir, { dataDir, configDir, nowMs: NOW + 1000 });
    expect(result.displaced).toBeDefined();
    expect(readFileSync(join(result.displaced as string, 'neurons.jsonl'), 'utf-8')).toContain(
      'n-new'
    );
    expect(readFileSync(join(dataDir, 'watcher', 'neurons.jsonl'), 'utf-8')).toContain('n-1');
  });

  test('a bot removed since the reset is skipped', () => {
    const plan = planMindReset({ dataDir, configDir, nowMs: NOW });
    applyMindReset(plan, { nowMs: NOW });
    writeFileSync(join(configDir, 'bots.json'), JSON.stringify([{ id: 'a', enabled: false }]));
    const result = restoreMindReset(plan.archiveDir, { dataDir, configDir, nowMs: NOW + 1000 });
    expect(result.reenabled).toEqual(['a']);
    expect(result.missing).toEqual(['c']);
  });

  test('refuses an archive that is not a mind reset', () => {
    mkdirSync(join(root, 'x'));
    expect(() => restoreMindReset(join(root, 'x'), { dataDir, configDir, nowMs: NOW })).toThrow(
      /not a mind reset/
    );
  });
});

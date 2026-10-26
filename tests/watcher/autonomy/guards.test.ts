import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GUARD_METRICS,
  breaches,
  createGuardReader,
  isGuardMetric,
  readFleetErrorShare,
  readWatcherCostPerDay,
} from '../../../src/watcher/autonomy/guards';
import { budgetFile } from '../../../src/watcher/budget';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autonomy-guards-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 86_400_000;
const HOUR = 3_600_000;

function budgetDay(date: string, notice: number, integrate: number) {
  writeFileSync(
    budgetFile(dir, date),
    JSON.stringify({
      date,
      notice: { calls: 1, tokens: 1, costUsd: notice },
      integrate: { calls: 1, tokens: 1, costUsd: integrate },
      capLogged: [],
    })
  );
}

function cycles(botId: string, date: string, statuses: string[], startMs: number) {
  const d = join(dir, 'agent-cycles', botId);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `${date}.jsonl`),
    statuses
      .map((status, i) =>
        JSON.stringify({
          cycleId: `${botId}-${i}`,
          startedAt: new Date(startMs + i * 60_000).toISOString(),
          status,
        })
      )
      .join('\n')
  );
}

describe('guard metrics', () => {
  it('knows the rung-0 metrics only', () => {
    expect([...GUARD_METRICS].sort()).toEqual(['fleet.errorCycleShare', 'watcher.costUsdPerDay']);
    expect(isGuardMetric('watcher.costUsdPerDay')).toBe(true);
    expect(isGuardMetric('watcher.anything')).toBe(false);
  });

  it('breaches: max above the bound, min below it', () => {
    const g = { metric: 'x', bound: 1, windowHours: 1 };
    expect(breaches({ ...g, direction: 'max' }, 1.01)).toBe(true);
    expect(breaches({ ...g, direction: 'max' }, 1)).toBe(false);
    expect(breaches({ ...g, direction: 'min' }, 0.99)).toBe(true);
    expect(breaches({ ...g, direction: 'min' }, 1)).toBe(false);
  });
});

describe('watcher.costUsdPerDay', () => {
  it('is the mean daily USD over the whole days since the change', () => {
    const since = Date.parse('2026-10-20T00:00:00Z');
    budgetDay('2026-10-20', 1, 1);
    budgetDay('2026-10-21', 2, 2);
    const now = Date.parse('2026-10-22T00:00:00Z');
    expect(readWatcherCostPerDay(dir, since, now)).toBeCloseTo(3, 6);
  });

  it('counts only the share of the apply day after the change', () => {
    // Applied at noon: half of 2026-10-20 (cost 4) counts, plus all of 10-21 (cost 2), over 1.5 days.
    const since = Date.parse('2026-10-20T12:00:00Z');
    budgetDay('2026-10-20', 2, 2);
    budgetDay('2026-10-21', 1, 1);
    const now = Date.parse('2026-10-22T00:00:00Z');
    expect(readWatcherCostPerDay(dir, since, now)).toBeCloseTo((2 + 2) / 1.5, 6);
  });

  it('a missing day counts as zero spend once another day has a file', () => {
    const since = Date.parse('2026-10-20T00:00:00Z');
    budgetDay('2026-10-20', 2, 0);
    const now = Date.parse('2026-10-22T00:00:00Z');
    expect(readWatcherCostPerDay(dir, since, now)).toBeCloseTo(1, 6);
  });

  it('no files, or too little time, is no reading', () => {
    const since = Date.parse('2026-10-20T00:00:00Z');
    expect(readWatcherCostPerDay(dir, since, since + 2 * DAY)).toBeUndefined();
    budgetDay('2026-10-20', 5, 5);
    expect(readWatcherCostPerDay(dir, since, since + HOUR)).toBeUndefined();
    writeFileSync(budgetFile(dir, '2026-10-21'), '{broken');
    expect(readWatcherCostPerDay(dir, since, since + 2 * DAY)).toBeCloseTo(5, 6);
  });
});

describe('fleet.errorCycleShare', () => {
  const since = Date.parse('2026-10-20T00:00:00Z');
  it('is the share of error cycles across bots since the change', () => {
    cycles('b1', '2026-10-20', ['completed', 'error', 'idle', 'completed'], since + HOUR);
    cycles('b2', '2026-10-20', ['error', 'skipped', 'completed', 'completed'], since + HOUR);
    cycles('b3', '2026-10-20', ['error', 'error', 'error', 'error', 'error'], since + HOUR);
    const share = readFleetErrorShare(join(dir, 'agent-cycles'), ['b1', 'b2'], since, since + DAY);
    expect(share).toBeCloseTo(2 / 8, 6);
  });

  it('ignores cycles before the change and is undefined with too few cycles', () => {
    cycles('b1', '2026-10-19', ['error', 'error', 'error', 'error', 'error'], since - 5 * HOUR);
    cycles('b1', '2026-10-20', ['completed', 'error'], since + HOUR);
    expect(
      readFleetErrorShare(join(dir, 'agent-cycles'), ['b1'], since, since + DAY)
    ).toBeUndefined();
    expect(readFleetErrorShare(join(dir, 'missing'), ['b1'], since, since + DAY)).toBeUndefined();
  });
});

describe('createGuardReader', () => {
  it('routes metrics, unknown is undefined', async () => {
    const since = Date.parse('2026-10-20T00:00:00Z');
    budgetDay('2026-10-20', 1, 0);
    const read = createGuardReader({
      watcherDir: dir,
      cyclesDir: join(dir, 'agent-cycles'),
      botIds: () => ['b1'],
    });
    expect(await read('watcher.costUsdPerDay', { sinceMs: since, nowMs: since + DAY })).toBeCloseTo(
      1,
      6
    );
    expect(
      await read('fleet.errorCycleShare', { sinceMs: since, nowMs: since + DAY })
    ).toBeUndefined();
    expect(await read('nope', { sinceMs: since, nowMs: since + DAY })).toBeUndefined();
  });
});

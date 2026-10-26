import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GUARD_METRICS,
  GUARD_MIN_WINDOW_HOURS,
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

  it('counts whole UTC days after the apply day only', () => {
    // Applied at noon: 2026-10-20 (cost 4) is the apply day and never counts; 10-21 (cost 2) does.
    const since = Date.parse('2026-10-20T12:00:00Z');
    budgetDay('2026-10-20', 2, 2);
    budgetDay('2026-10-21', 1, 1);
    budgetDay('2026-10-22', 5, 5);
    // 10-22 has not ended yet: not counted either.
    const now = Date.parse('2026-10-22T18:00:00Z');
    expect(readWatcherCostPerDay(dir, since, now)).toBeCloseTo(2, 6);
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

describe('review round 1: cost guard', () => {
  it('spend before the change on the apply day is never attributed to after it', () => {
    // $12 before noon, the change at noon, nothing after.
    const since = Date.parse('2026-10-20T12:00:00Z');
    budgetDay('2026-10-20', 6, 6);
    expect(readWatcherCostPerDay(dir, since, Date.parse('2026-10-20T18:00:00Z'))).toBeUndefined();
    budgetDay('2026-10-21', 0, 0);
    expect(readWatcherCostPerDay(dir, since, Date.parse('2026-10-22T00:00:00Z'))).toBe(0);
  });

  it('every guard metric declares a minimum window, and an hourly check inside it always reads', () => {
    for (const m of GUARD_METRICS) expect(GUARD_MIN_WINDOW_HOURS[m]).toBeGreaterThan(0);
    const win = GUARD_MIN_WINDOW_HOURS['watcher.costUsdPerDay'] * HOUR;
    for (const date of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) {
      budgetDay(date, 1, 1);
    }
    const dayStart = Date.parse('2026-10-20T00:00:00Z');
    // Applied at any minute of the day, ticks at any phase of the hour.
    for (let applyMin = 0; applyMin < 24 * 60; applyMin += 37) {
      const since = dayStart + applyMin * 60_000 + 1;
      for (const phaseMin of [1, 20, 59, 60]) {
        let read = false;
        for (let tick = since + phaseMin * 60_000; tick <= since + win; tick += HOUR) {
          if (readWatcherCostPerDay(dir, since, tick) !== undefined) read = true;
        }
        expect(read).toBe(true);
      }
    }
  });
});

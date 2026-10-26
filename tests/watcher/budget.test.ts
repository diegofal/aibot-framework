import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BudgetLimits, DailyBudget, budgetFile } from '../../src/watcher/budget';

let dir: string;
let t: number;
let limits: BudgetLimits;
let open: Record<string, boolean>;

function make() {
  return new DailyBudget({
    dir,
    limits: () => limits,
    now: () => t,
    isCircuitOpen: (tier) => open[tier] === true,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-budget-'));
  t = Date.parse('2026-10-23T10:00:00Z');
  limits = { notice: { maxPerDay: 2 }, integrate: { maxPerDay: 1, maxTokensPerDay: 1000 } };
  open = {};
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('DailyBudget', () => {
  test('allows calls until the tier hits its daily cap', () => {
    const b = make();
    expect(b.allow('notice')).toEqual({ ok: true });
    b.record('notice', { tokens: 10, costUsd: 0.01 });
    b.record('notice', { tokens: 10, costUsd: 0.01 });
    expect(b.allow('notice')).toEqual({ ok: false, reason: 'cap' });
    expect(b.allow('integrate')).toEqual({ ok: true });
  });

  test('integrate also stops at its token cap', () => {
    limits.integrate.maxPerDay = 10;
    const b = make();
    b.record('integrate', { tokens: 1000 });
    expect(b.allow('integrate')).toEqual({ ok: false, reason: 'tokens' });
  });

  test('a cap of 0 never allows a call', () => {
    limits.notice.maxPerDay = 0;
    expect(make().allow('notice')).toEqual({ ok: false, reason: 'cap' });
  });

  test('resets at UTC midnight', () => {
    const b = make();
    b.record('notice', {});
    b.record('notice', {});
    expect(b.allow('notice').ok).toBe(false);
    t = Date.parse('2026-10-24T00:00:01Z');
    expect(b.allow('notice')).toEqual({ ok: true });
    expect(b.used('notice')).toMatchObject({ calls: 0, tokens: 0, costUsd: 0 });
  });

  test('an open circuit blocks the tier before the cap is reached', () => {
    open.notice = true;
    const b = make();
    expect(b.allow('notice')).toEqual({ ok: false, reason: 'breaker' });
    expect(b.allow('integrate')).toEqual({ ok: true });
  });

  test('persists the day to budget-YYYY-MM-DD.json and reloads it', () => {
    const b = make();
    b.record('notice', { tokens: 120, costUsd: 0.002 });
    const file = budgetFile(dir, '2026-10-23');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8')).notice).toMatchObject({ calls: 1, tokens: 120 });
    const again = make();
    expect(again.used('notice')).toMatchObject({ calls: 1, tokens: 120, costUsd: 0.002 });
  });

  test('a corrupt file reads as an empty day', () => {
    writeFileSync(budgetFile(dir, '2026-10-23'), '{nope');
    expect(make().used('notice').calls).toBe(0);
  });

  test('firstCapToday is true once per tier per day, across restarts', () => {
    const b = make();
    expect(b.firstCapToday('notice')).toBe(true);
    expect(b.firstCapToday('notice')).toBe(false);
    expect(make().firstCapToday('notice')).toBe(false);
    expect(b.firstCapToday('integrate')).toBe(true);
    t = Date.parse('2026-10-24T08:00:00Z');
    expect(b.firstCapToday('notice')).toBe(true);
  });
});

describe('DailyBudget.reserve (concurrent calls)', () => {
  test('a reservation counts against the cap until it is recorded', () => {
    limits.integrate.maxPerDay = 1;
    const b = make();
    expect(b.reserve('integrate')).toEqual({ ok: true });
    // a second trigger while the first call is in flight is refused
    expect(b.reserve('integrate')).toEqual({ ok: false, reason: 'cap' });
    expect(b.allow('integrate')).toEqual({ ok: false, reason: 'cap' });
    b.record('integrate', { tokens: 5 });
    expect(b.used('integrate').calls).toBe(1);
    expect(b.allow('integrate')).toEqual({ ok: false, reason: 'cap' });
  });

  test('recording releases the reservation (no double count)', () => {
    limits.notice.maxPerDay = 2;
    const b = make();
    b.reserve('notice');
    b.record('notice', {});
    expect(b.reserve('notice')).toEqual({ ok: true });
    b.record('notice', {});
    expect(b.allow('notice')).toEqual({ ok: false, reason: 'cap' });
  });

  test('a refused reservation reserves nothing', () => {
    open.integrate = true;
    const b = make();
    expect(b.reserve('integrate')).toEqual({ ok: false, reason: 'breaker' });
    open.integrate = false;
    expect(b.reserve('integrate')).toEqual({ ok: true });
  });
});

describe('DailyBudget monthly ceiling (C6)', () => {
  let ceiling: number | undefined;
  function withCeiling() {
    return new DailyBudget({
      dir,
      limits: () => limits,
      now: () => t,
      isCircuitOpen: (tier) => open[tier] === true,
      monthlyCeilingUsd: () => ceiling,
    });
  }
  function day(date: string, notice: number, integrate: number) {
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

  beforeEach(() => {
    ceiling = 90;
    limits = {
      notice: { maxPerDay: 100 },
      integrate: { maxPerDay: 100, maxTokensPerDay: 1_000_000 },
    };
  });

  test('monthToDate sums both tiers over this UTC month, today included', () => {
    day('2026-10-01', 1, 10);
    day('2026-10-22', 0.5, 20);
    day('2026-09-30', 100, 100); // last month
    day('2026-11-01', 100, 100); // a future file never counts
    const b = withCeiling();
    b.record('notice', { costUsd: 0.25 });
    b.record('integrate', { costUsd: 2 });
    expect(b.monthToDate()).toBeCloseTo(1 + 10 + 0.5 + 20 + 0.25 + 2, 6);
  });

  test('bad files, odd names and negative costs never throw and count as nothing', () => {
    day('2026-10-02', 3, 0);
    writeFileSync(budgetFile(dir, '2026-10-03'), '{nope');
    writeFileSync(join(dir, 'budget-2026-10-04.json.tmp-1'), '{"notice":{"costUsd":50}}');
    writeFileSync(join(dir, 'budget-garbage.json'), '{"notice":{"costUsd":50}}');
    writeFileSync(
      budgetFile(dir, '2026-10-05'),
      JSON.stringify({ notice: { costUsd: -40 }, integrate: { costUsd: 'x' } })
    );
    expect(withCeiling().monthToDate()).toBeCloseTo(3, 6);
  });

  test('a missing dir is zero', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(withCeiling().monthToDate()).toBe(0);
  });

  test('a restart never resets it: a new budget reads the same files', () => {
    const b = withCeiling();
    b.record('integrate', { costUsd: 4 });
    expect(withCeiling().monthToDate()).toBeCloseTo(4, 6);
  });

  test('reserve refuses with ceiling once month-to-date reaches it', () => {
    day('2026-10-10', 40, 49);
    const b = withCeiling();
    expect(b.reserve('notice')).toEqual({ ok: true });
    b.record('notice', { costUsd: 1 }); // now exactly 90
    expect(b.reserve('notice')).toEqual({ ok: false, reason: 'ceiling' });
    expect(b.reserve('integrate')).toEqual({ ok: false, reason: 'ceiling' });
    expect(b.allow('integrate')).toEqual({ ok: false, reason: 'ceiling' });
  });

  test('a ceiling of 0 refuses every call', () => {
    ceiling = 0;
    const b = withCeiling();
    expect(b.reserve('notice')).toEqual({ ok: false, reason: 'ceiling' });
    expect(b.reserve('integrate')).toEqual({ ok: false, reason: 'ceiling' });
  });

  test('no ceiling configured never refuses on cost', () => {
    ceiling = undefined;
    day('2026-10-10', 1000, 1000);
    expect(withCeiling().reserve('integrate')).toEqual({ ok: true });
  });

  test('a changed ceiling applies on the next call, without a restart', () => {
    day('2026-10-10', 50, 0);
    const b = withCeiling();
    expect(b.reserve('notice').ok).toBe(true);
    b.record('notice', {});
    ceiling = 40;
    expect(b.reserve('notice')).toEqual({ ok: false, reason: 'ceiling' });
    ceiling = 60;
    expect(b.reserve('notice').ok).toBe(true);
  });

  // Cost is known only after a call: the check is before it, so the last call
  // allowed below the ceiling (and any already in flight) can overshoot it.
  test('one call allowed just below the ceiling can overshoot it; the next is refused', () => {
    day('2026-10-10', 89.99, 0);
    const b = withCeiling();
    expect(b.reserve('integrate')).toEqual({ ok: true });
    expect(b.reserve('integrate')).toEqual({ ok: true }); // in flight: its cost is unknown yet
    b.record('integrate', { costUsd: 3 });
    b.record('integrate', { costUsd: 3 });
    expect(b.monthToDate()).toBeCloseTo(95.99, 6);
    expect(b.reserve('notice')).toEqual({ ok: false, reason: 'ceiling' });
  });

  test('the ceiling is checked before the breaker and the daily cap', () => {
    ceiling = 0;
    open.notice = true;
    limits.notice.maxPerDay = 0;
    expect(withCeiling().allow('notice')).toEqual({ ok: false, reason: 'ceiling' });
  });

  test('past days are read once per day: a changed past file is not re-read the same day', () => {
    day('2026-10-10', 5, 0);
    const b = withCeiling();
    expect(b.monthToDate()).toBeCloseTo(5, 6);
    day('2026-10-10', 70, 0); // past days are immutable for the running process
    expect(b.monthToDate()).toBeCloseTo(5, 6);
    t = Date.parse('2026-10-24T00:00:01Z'); // a new day re-reads the month
    expect(b.monthToDate()).toBeCloseTo(70, 6);
  });

  test('yesterday joins the past sum at midnight, its in-memory spend included', () => {
    const b = withCeiling();
    b.record('notice', { costUsd: 2 }); // 2026-10-23
    t = Date.parse('2026-10-24T00:00:01Z');
    b.record('notice', { costUsd: 1 });
    expect(b.monthToDate()).toBeCloseTo(3, 6);
  });

  test('a new month starts from zero', () => {
    day('2026-10-10', 80, 9);
    const b = withCeiling();
    b.record('integrate', { costUsd: 2 });
    expect(b.reserve('notice')).toEqual({ ok: false, reason: 'ceiling' });
    t = Date.parse('2026-11-01T00:00:01Z');
    expect(b.monthToDate()).toBe(0);
    expect(b.reserve('notice')).toEqual({ ok: true });
  });

  test('monthToDate(nowMs) reads the month of that instant', () => {
    day('2026-09-15', 7, 0);
    day('2026-10-10', 1, 0);
    const b = withCeiling();
    expect(b.monthToDate(Date.parse('2026-09-20T12:00:00Z'))).toBeCloseTo(7, 6);
    expect(b.monthToDate()).toBeCloseTo(1, 6);
  });

  test('firstCapToday(ceiling) is one row a day, like the tier caps', () => {
    const b = withCeiling();
    expect(b.firstCapToday('ceiling')).toBe(true);
    expect(b.firstCapToday('ceiling')).toBe(false);
    expect(withCeiling().firstCapToday('ceiling')).toBe(false);
    expect(b.firstCapToday('notice')).toBe(true);
  });
});

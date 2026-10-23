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

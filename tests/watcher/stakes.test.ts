/**
 * O3 (docs/plans/watcher-optimizations-plan.md): interoception that shapes
 * behaviour. Each rule from a fixture interoception.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KARMA_SAMPLE_EVERY_MS,
  KarmaTrend,
  STAKE_PHASE,
  type StakesInput,
  newlyFired,
  stakes,
  stakesFor,
} from '../../src/watcher/stakes';

const HOUR = 3_600_000;
const usage = (calls: number, tokens = 0) => ({ calls, tokens, costUsd: 0 });

function input(over: Partial<StakesInput> = {}): StakesInput {
  return {
    interoception: { breakerOpen: [], operatorSilenceHours: 5, fleetKarmaAvg: 60 },
    budget: { notice: usage(0), integrate: usage(0) },
    limits: { notice: { maxPerDay: 100 }, integrate: { maxPerDay: 8, maxTokensPerDay: 1000 } },
    backends: { notice: 'claude-cli', integrate: 'claude-cli' },
    karmaPeak: 60,
    ...over,
  };
}

describe('stakes()', () => {
  test('a calm watcher: nothing fires, nothing changes', () => {
    const s = stakes(input());
    expect(s.fired).toEqual([]);
    expect(s.noticeWakeFactor).toBe(1);
    expect(s.integrateWakeFactor).toBe(1);
    expect(s.deferQuestions).toBe(false);
    expect(s.releaseQuestions).toBe(false);
    expect(s.asleep).toEqual({ notice: false, integrate: false });
    expect(s.somethingWrong).toBeUndefined();
  });

  test('budget pressure: 75 % of a tier used doubles that tier’s wake line', () => {
    const s = stakes(input({ budget: { notice: usage(74), integrate: usage(6) } }));
    expect(s.fired).toEqual(['integrateBudgetPressure']);
    expect(s.integrateWakeFactor).toBe(2);
    expect(s.noticeWakeFactor).toBe(1);
    const n = stakes(input({ budget: { notice: usage(75), integrate: usage(1) } }));
    expect(n.fired).toEqual(['noticeBudgetPressure']);
    expect(n.noticeWakeFactor).toBe(2);
  });

  test('integrate tokens count as budget too', () => {
    const s = stakes(input({ budget: { notice: usage(0), integrate: usage(1, 800) } }));
    expect(s.fired).toContain('integrateBudgetPressure');
  });

  test('a tier with a zero cap is not under pressure (it never runs)', () => {
    const s = stakes(
      input({
        limits: { notice: { maxPerDay: 0 }, integrate: { maxPerDay: 0, maxTokensPerDay: 0 } },
      })
    );
    expect(s.fired).toEqual([]);
  });

  test('operator silent > 48 h: questions are deferred', () => {
    const s = stakes(
      input({ interoception: { breakerOpen: [], operatorSilenceHours: 49, fleetKarmaAvg: 60 } })
    );
    expect(s.fired).toEqual(['operatorSilence']);
    expect(s.deferQuestions).toBe(true);
    expect(s.releaseQuestions).toBe(false);
  });

  test('an operator never seen is not silent (unknown is not a reason to hold back)', () => {
    const s = stakes(
      input({ interoception: { breakerOpen: [], operatorSilenceHours: null, fleetKarmaAvg: 60 } })
    );
    expect(s.deferQuestions).toBe(false);
  });

  test('operator wrote in the last hour: deferred questions go out', () => {
    const s = stakes(
      input({ interoception: { breakerOpen: [], operatorSilenceHours: 0.5, fleetKarmaAvg: 60 } })
    );
    expect(s.fired).toEqual(['operatorPresent']);
    expect(s.releaseQuestions).toBe(true);
    expect(s.deferQuestions).toBe(false);
  });

  test('breaker open on a tier’s backend: that tier sleeps', () => {
    const s = stakes(
      input({
        interoception: { breakerOpen: ['claude-cli'], operatorSilenceHours: 5, fleetKarmaAvg: 60 },
        backends: { notice: 'ollama', integrate: 'claude-cli' },
      })
    );
    expect(s.fired).toEqual(['breakerOpen']);
    expect(s.asleep).toEqual({ notice: false, integrate: true });
  });

  test('fleet karma down ≥ 5 from its 24 h peak: something is wrong', () => {
    const s = stakes(
      input({
        interoception: { breakerOpen: [], operatorSilenceHours: 5, fleetKarmaAvg: 54.5 },
        karmaPeak: 60,
      })
    );
    expect(s.fired).toEqual(['fleetKarmaFalling']);
    expect(s.somethingWrong).toContain('60');
    expect(s.somethingWrong).toContain('54.5');
    const calm = stakes(
      input({
        interoception: { breakerOpen: [], operatorSilenceHours: 5, fleetKarmaAvg: 55.5 },
        karmaPeak: 60,
      })
    );
    expect(calm.fired).toEqual([]);
  });

  test('every fired rule has a note and a phase', () => {
    const s = stakes(
      input({
        interoception: { breakerOpen: ['claude-cli'], operatorSilenceHours: 50, fleetKarmaAvg: 40 },
        budget: { notice: usage(90), integrate: usage(7) },
        karmaPeak: 60,
      })
    );
    expect(s.fired.length).toBe(5);
    for (const rule of s.fired) {
      expect(s.notes[rule]?.length).toBeGreaterThan(10);
      expect(STAKE_PHASE[rule]).toBeDefined();
    }
  });

  test('stakesFor keeps the rules that shape each tier’s pass', () => {
    const s = stakes(
      input({
        interoception: { breakerOpen: [], operatorSilenceHours: 50, fleetKarmaAvg: 40 },
        budget: { notice: usage(90), integrate: usage(7) },
        karmaPeak: 60,
      })
    );
    expect(stakesFor('notice', s)).toEqual(['noticeBudgetPressure']);
    expect(stakesFor('integrate', s)).toEqual([
      'integrateBudgetPressure',
      'operatorSilence',
      'fleetKarmaFalling',
    ]);
  });

  test('newlyFired: only the rules that were not firing before', () => {
    const s = stakes(input({ budget: { notice: usage(90), integrate: usage(7) } }));
    expect(newlyFired(new Set(), s)).toEqual(['noticeBudgetPressure', 'integrateBudgetPressure']);
    expect(newlyFired(new Set(['noticeBudgetPressure']), s)).toEqual(['integrateBudgetPressure']);
  });
});

describe('KarmaTrend', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-stakes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('the peak over the last 24 h, sampled at most every 10 min, survives a restart', () => {
    const t0 = Date.parse('2026-10-24T00:00:00Z');
    const trend = new KarmaTrend(join(dir, 'stakes.json'));
    trend.record(t0, 60);
    trend.record(t0 + 60_000, 70); // within the sampling gap: ignored
    trend.record(t0 + KARMA_SAMPLE_EVERY_MS, 58);
    expect(trend.peak(t0 + KARMA_SAMPLE_EVERY_MS)).toBe(60);
    const again = new KarmaTrend(join(dir, 'stakes.json'));
    expect(again.peak(t0 + KARMA_SAMPLE_EVERY_MS)).toBe(60);
    // A day later the 60 is out of the window.
    expect(again.peak(t0 + 24 * HOUR + 1)).toBe(58);
    expect(again.peak(t0 + 48 * HOUR)).toBeNull();
  });

  test('when the operator last wrote survives a restart and only moves forward', () => {
    const file = join(dir, 'stakes.json');
    const trend = new KarmaTrend(file);
    expect(trend.operatorAt()).toBeNull();
    trend.setOperatorAt(1_000);
    trend.setOperatorAt(500);
    trend.record(2_000, 60);
    const again = new KarmaTrend(file);
    expect(again.operatorAt()).toBe(1_000);
    expect(again.peak(2_000)).toBe(60);
  });

  test('a corrupt file is a cold start', () => {
    const file = join(dir, 'stakes.json');
    writeFileSync(file, '{nope');
    expect(new KarmaTrend(file).peak(Date.now())).toBeNull();
  });
});

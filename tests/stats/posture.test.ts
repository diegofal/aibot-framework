import { describe, expect, it } from 'bun:test';
import { type PostureInput, computePosture, computePostureWithRule } from '../../src/stats/posture';

const NOW = Date.UTC(2026, 7, 21, 12);
const H = 3_600_000;

function base(overrides: Partial<PostureInput> = {}): PostureInput {
  return {
    enabled: true,
    nowMs: NOW,
    lastRunAt: NOW - H,
    retryCount: 0,
    lastError: null,
    consecutiveIdleCycles: 0,
    goalsActive: 2,
    goalsByStatus: { active: 2 },
    lastOutcomeAt: NOW - 2 * H,
    ...overrides,
  };
}

describe('computePosture', () => {
  it('disabled bot is dormant regardless of anything else', () => {
    expect(computePosture(base({ enabled: false }))).toBe('dormant');
  });
  it('never-run bot is unknown', () => {
    expect(computePosture(base({ lastRunAt: null }))).toBe('unknown');
  });
  it('retrying with an error is blocked', () => {
    expect(computePosture(base({ retryCount: 3, lastError: 'boom' }))).toBe('blocked');
  });
  it('all active goals blocked → blocked', () => {
    expect(computePosture(base({ goalsActive: 2, goalsByStatus: { blocked: 2 } }))).toBe('blocked');
  });
  it('no active goals → idle', () => {
    expect(computePosture(base({ goalsActive: 0, goalsByStatus: {} }))).toBe('idle');
  });
  it('recent outcome and no idle streak → active', () => {
    expect(computePosture(base())).toBe('active');
  });
  it('long idle streak → standby even with goals', () => {
    expect(computePosture(base({ consecutiveIdleCycles: 5 }))).toBe('standby');
  });
  it('no recent outcome but some idle cycles → standby', () => {
    expect(computePosture(base({ consecutiveIdleCycles: 2, lastOutcomeAt: NOW - 72 * H }))).toBe(
      'standby'
    );
  });
  it('stale last run (older than 3 days) → standby', () => {
    expect(computePosture(base({ lastRunAt: NOW - 4 * 24 * H }))).toBe('standby');
  });
});

describe('computePostureWithRule', () => {
  const cases: Array<[string, Partial<PostureInput>, string, string]> = [
    ['disabled', { enabled: false }, 'dormant', 'disabled'],
    ['never ran', { lastRunAt: null }, 'unknown', 'never-ran'],
    ['retries', { retryCount: 3, lastError: 'boom' }, 'blocked', 'retries'],
    ['all goals blocked', { goalsByStatus: { blocked: 2 } }, 'blocked', 'all-goals-blocked'],
    ['no goals', { goalsActive: 0, goalsByStatus: {} }, 'idle', 'no-goals'],
    ['idle streak', { consecutiveIdleCycles: 5 }, 'standby', 'idle-streak'],
    ['stale run', { lastRunAt: NOW - 4 * 24 * H }, 'standby', 'stale-run'],
    [
      'no recent outcome',
      { consecutiveIdleCycles: 2, lastOutcomeAt: NOW - 72 * H },
      'standby',
      'no-recent-outcome',
    ],
    ['active', {}, 'active', 'active'],
  ];
  for (const [name, over, posture, rule] of cases) {
    it(`${name} → ${posture} by rule ${rule}`, () => {
      const r = computePostureWithRule(base(over));
      expect(r.posture).toBe(posture as never);
      expect(r.rule).toBe(rule as never);
      expect(computePosture(base(over))).toBe(r.posture);
    });
  }
  it('carries the inputs it decided on', () => {
    const r = computePostureWithRule(base({ consecutiveIdleCycles: 5 }));
    expect(r.inputs.consecutiveIdleCycles).toBe(5);
    expect(r.inputs.nowMs).toBe(NOW);
  });
});

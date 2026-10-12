import { describe, expect, it } from 'bun:test';
import { type PostureInput, computePostureWithRule } from '../../../src/stats/posture';
import { postureToWhy } from '../../../src/why/builders/posture';
import { WhySchema } from '../../../src/why/types';

const NOW = Date.UTC(2026, 9, 11, 12);
const H = 3_600_000;

const input = (over: Partial<PostureInput> = {}): PostureInput => ({
  enabled: true,
  nowMs: NOW,
  lastRunAt: NOW - H,
  retryCount: 0,
  lastError: null,
  consecutiveIdleCycles: 0,
  goalsActive: 2,
  goalsByStatus: { active: 2 },
  lastOutcomeAt: NOW - 2 * H,
  ...over,
});

const why = (over: Partial<PostureInput>) => postureToWhy(computePostureWithRule(input(over)));

describe('postureToWhy', () => {
  it('says the posture and that the system decided it', () => {
    const w = why({ consecutiveIdleCycles: 5 });
    expect(w.what).toBe('Posture: standby');
    expect(w.by).toBe('system');
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('names the rule that fired in plain words', () => {
    expect(why({ consecutiveIdleCycles: 5 }).rule).toBe('5 idle cycles in a row (standby from 5).');
    expect(why({ lastRunAt: NOW - 4 * 24 * H }).rule).toBe(
      'Last run 4 days ago (standby after 3 days).'
    );
    expect(why({ consecutiveIdleCycles: 2, lastOutcomeAt: NOW - 72 * H }).rule).toBe(
      'No output in the last 48 h (last one 3 days ago), and its last 2 cycles were idle.'
    );
    expect(why({ consecutiveIdleCycles: 1, lastOutcomeAt: null }).rule).toBe(
      'No output recorded yet, and its last cycle was idle.'
    );
    expect(why({ retryCount: 3, lastError: 'quota exceeded' }).rule).toBe(
      '3 failed retries in a row. Last error: quota exceeded'
    );
    expect(why({ goalsByStatus: { blocked: 2 } }).rule).toBe(
      'Every active goal is blocked (2 of 2).'
    );
    expect(why({ goalsActive: 0, goalsByStatus: {} }).rule).toBe('No active goals to pursue.');
    expect(why({ enabled: false }).rule).toBe('Turned off in its config.');
    expect(why({ lastRunAt: null }).rule).toBe('Its agent loop has never run.');
    expect(why({}).rule).toBe('Has active goals and produced output in the last 48 h.');
    expect(why({ lastOutcomeAt: null }).rule).toBe(
      'Has active goals and its latest cycle was not idle.'
    );
  });

  it('lists what it decided on as a note', () => {
    const note = why({ consecutiveIdleCycles: 5 }).notes?.find((n) => n.label === 'Based on');
    expect(note?.text).toBe(
      '2 active goals · 5 idle cycles in a row · last run 1 h ago · last output 2 h ago'
    );
  });

  it('says plainly when a number is not known', () => {
    const note = why({ lastOutcomeAt: null }).notes?.find((n) => n.label === 'Based on');
    expect(note?.text).toContain('no output recorded');
  });
});

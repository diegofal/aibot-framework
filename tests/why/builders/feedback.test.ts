import { describe, expect, it } from 'bun:test';
import { feedbackToWhy } from '../../../src/why/builders/feedback';
import type { CycleRow } from '../../../src/why/cycle-index';
import { WhySchema } from '../../../src/why/types';

const cycle: CycleRow = {
  cycleId: 'c-1',
  startedAt: '2026-10-11T12:00:00.000Z',
  endedAt: '2026-10-11T12:05:00.000Z',
  planSummary: 'Review the inbox',
  goalId: 'g-1',
  goalTitle: 'Keep the inbox clear',
};

describe('feedbackToWhy', () => {
  it('handled: the cycle that handled it', () => {
    const why = feedbackToWhy({
      botId: 'b1',
      status: 'applied',
      appliedAt: '2026-10-11T12:03:00.000Z',
      cycleId: 'c-1',
      cycle,
    });
    expect(why).toEqual({
      what: 'Your feedback',
      by: 'operator',
      cycle: {
        id: 'c-1',
        botId: 'b1',
        startedAt: '2026-10-11T12:00:00.000Z',
        plan: 'Review the inbox',
      },
      outcome: 'Handled in a cycle.',
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('pending: not handled yet, nothing missing', () => {
    const why = feedbackToWhy({ botId: 'b1', status: 'pending' });
    expect(why.outcome).toBe('Not handled yet.');
    expect(why.missing).toBeUndefined();
    expect(why.cycle).toBeUndefined();
  });

  it('handled before cycles were recorded says so', () => {
    const why = feedbackToWhy({ botId: 'b1', status: 'applied' });
    expect(why.outcome).toBe('Handled.');
    expect(why.missing).toContain('No record of the cycle that handled it');
  });

  it('a cycle id the log does not have', () => {
    const why = feedbackToWhy({ botId: 'b1', status: 'applied', cycleId: 'c-gone' });
    expect(why.cycle).toEqual({ id: 'c-gone', botId: 'b1' });
    expect(why.outcome).toBe('Handled in a cycle.');
    expect(why.missing).toContain('cycle log has no row');
  });

  it('dismissed', () => {
    expect(feedbackToWhy({ botId: 'b1', status: 'dismissed' }).outcome).toBe('You dismissed it.');
  });
});

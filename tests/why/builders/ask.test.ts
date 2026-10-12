import { describe, expect, it } from 'bun:test';
import { askOutcome, askToWhy } from '../../../src/why/builders/ask';
import type { CycleRow } from '../../../src/why/cycle-index';
import { WhySchema } from '../../../src/why/types';

const cycle: CycleRow = {
  cycleId: 'c-1',
  startedAt: '2026-10-11T12:00:00.000Z',
  endedAt: '2026-10-11T12:05:00.000Z',
  planSummary: 'Draft the cover letter',
  goalId: 'g-1',
  goalTitle: 'Land a remote role',
};

describe('askToWhy', () => {
  it('names the cycle that asked, its plan and goal, and that it waits on you', () => {
    const why = askToWhy({ botId: 'b1', cycleId: 'c-1', goalId: 'g-1', cycle, status: 'pending' });
    expect(why).toEqual({
      what: 'A question it asked you during a work cycle',
      by: 'agent',
      cycle: {
        id: 'c-1',
        botId: 'b1',
        startedAt: '2026-10-11T12:00:00.000Z',
        plan: 'Draft the cover letter',
      },
      goal: { id: 'g-1', title: 'Land a remote role' },
      outcome: 'Waiting for your answer.',
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('says plainly when no cycle was recorded', () => {
    const why = askToWhy({ botId: 'b1' });
    expect(why.what).toBe('A question it asked you');
    expect(why.cycle).toBeUndefined();
    expect(why.missing).toContain('No record of a work cycle');
    expect(why.outcome).toBe('Waiting for your answer.');
  });

  it('keeps a recorded cycle the log has no row for', () => {
    const why = askToWhy({ botId: 'b1', cycleId: 'c-9', goalId: 'g-1' });
    expect(why.cycle).toEqual({ id: 'c-9', botId: 'b1' });
    expect(why.goal).toBeUndefined();
    expect(why.missing).toContain('cycle log has no row');
  });
});

describe('askOutcome', () => {
  it('says what happened to the question', () => {
    expect(askOutcome('answered')).toBe('You answered it.');
    expect(askOutcome('dismissed')).toBe('You dismissed it without answering.');
    expect(askOutcome('timed_out')).toBe('It timed out without an answer.');
    expect(askOutcome('closed')).toBe('Closed.');
    expect(askOutcome(undefined)).toBe('Waiting for your answer.');
  });
});

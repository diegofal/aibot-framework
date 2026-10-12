import { describe, expect, it } from 'bun:test';
import { idleToWhy } from '../../../src/why/builders/idle';
import { WhySchema } from '../../../src/why/types';

describe('idleToWhy', () => {
  it('an idle plan: the planner reasoning, the cycle, no rule', () => {
    const w = idleToWhy({ botId: 'b1', cycleId: 'c1', reasoning: 'Waiting for feedback.' });
    expect(w).toEqual({
      what: 'Idle cycle',
      by: 'agent',
      cycle: { id: 'c1', botId: 'b1' },
      reason: { text: 'Waiting for feedback.', source: 'Planner' },
      outcome: 'Nothing was run this cycle.',
    });
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('the engagement gate: the rule that fired and the plan it held back', () => {
    const w = idleToWhy({
      botId: 'b1',
      cycleId: 'c1',
      reasoning: 'Publish another guide.',
      gate: { outputCount: 6, feedbackCount: 0, plan: ['Write guide 7', 'Publish it'] },
    });
    expect(w.by).toBe('system');
    expect(w.rule).toBe(
      'Engagement gate: 6 outputs and 0 feedback since your last response, so content plans wait until you react.'
    );
    expect(w.reason).toEqual({ text: 'Publish another guide.', source: 'Planner' });
    expect(w.notes).toEqual([{ label: 'Held back', text: 'Write guide 7; Publish it' }]);
    expect(w.outcome).toBe('The planned content was not run.');
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('says plainly what is missing', () => {
    const w = idleToWhy({ botId: 'b1', reasoning: '  ' });
    expect(w.cycle).toBeUndefined();
    expect(w.reason).toBeUndefined();
    expect(w.missing).toBe('The planner gave no reason. No cycle id was recorded with this event.');
    expect(WhySchema.safeParse(w).success).toBe(true);
  });
});

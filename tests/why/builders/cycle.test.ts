import { describe, expect, it } from 'bun:test';
import { cycleToWhy } from '../../../src/why/builders/cycle';
import { WhySchema } from '../../../src/why/types';

const row = {
  cycleId: 'c1',
  startedAt: '2026-10-11T10:00:00.000Z',
  endedAt: '2026-10-11T10:04:00.000Z',
  status: 'completed',
  focus: 'Ship the job list',
  planSummary: 'Search FDE roles',
  toolCalls: 3,
  tools: ['web_search', 'file_write'],
  goalId: 'g-1',
  goalTitle: 'Find remote roles',
  goalSource: 'planner',
};

describe('cycleToWhy', () => {
  it('a recorded cycle: plan, goal, focus and what came of it', () => {
    const w = cycleToWhy({ botId: 'b1', cycle: row });
    expect(w).toEqual({
      what: 'Agent-loop cycle',
      by: 'agent',
      cycle: { id: 'c1', botId: 'b1', startedAt: row.startedAt, plan: 'Search FDE roles' },
      goal: { id: 'g-1', title: 'Find remote roles' },
      reason: { text: 'Ship the job list', source: 'Focus set for the cycle' },
      outcome: 'Completed with 3 tool calls (web_search, file_write).',
    });
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('idle, skipped and error cycles say so; no goal is said plainly', () => {
    const base = { cycleId: 'c2', startedAt: row.startedAt };
    expect(cycleToWhy({ botId: 'b1', cycle: { ...base, status: 'idle' } }).outcome).toBe(
      'Idle: it planned nothing to run.'
    );
    expect(cycleToWhy({ botId: 'b1', cycle: { ...base, status: 'skipped' } }).outcome).toBe(
      'Skipped before planning.'
    );
    expect(cycleToWhy({ botId: 'b1', cycle: { ...base, status: 'error' } }).outcome).toBe(
      'Ended with an error.'
    );
    const w = cycleToWhy({ botId: 'b1', cycle: { ...base, status: 'completed', toolCalls: 0 } });
    expect(w.outcome).toBe('Completed without tool calls.');
    expect(w.goal).toBeUndefined();
    expect(w.missing).toBe('The cycle did not name a goal it served.');
    expect(WhySchema.safeParse(w).success).toBe(true);
  });
});

describe('cycleToWhy: what the cycle row recorded (why-everywhere row 11)', () => {
  const base = { cycleId: 'c3', startedAt: row.startedAt };

  it('idle: the planner reasoning is the reason', () => {
    const w = cycleToWhy({
      botId: 'b1',
      cycle: { ...base, status: 'idle', reason: 'Waiting for feedback.', reasonSource: 'planner' },
    });
    expect(w.reason).toEqual({ text: 'Waiting for feedback.', source: 'Planner' });
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('idle by the engagement gate, skipped by the circuit breaker: a rule', () => {
    const gate = cycleToWhy({
      botId: 'b1',
      cycle: {
        ...base,
        status: 'idle',
        reason: 'Engagement gate: content blocked until feedback (6 outputs, 0 feedback)',
        reasonSource: 'engagement-gate',
      },
    });
    expect(gate.rule).toBe(
      'Engagement gate: content blocked until feedback (6 outputs, 0 feedback)'
    );
    const circuit = cycleToWhy({
      botId: 'b1',
      cycle: {
        ...base,
        status: 'skipped',
        reason: 'circuit-open:claude-cli',
        reasonSource: 'circuit-breaker',
      },
    });
    expect(circuit.rule).toBe(
      'The claude-cli circuit breaker was open after repeated quota/429 errors, so the cycle sat out.'
    );
    expect(WhySchema.safeParse(circuit).success).toBe(true);
  });

  it('error: the error is a note; strategist reflection and trait deltas are notes too', () => {
    const w = cycleToWhy({
      botId: 'b1',
      cycle: {
        ...row,
        strategistRan: true,
        reflection: 'Stuck on tooling.',
        traitAdjustments: { caution: 0.03, depth: -0.02 },
      },
    });
    expect(w.notes).toEqual([
      { label: 'Strategist reflection', text: 'Stuck on tooling.' },
      { label: 'Traits adjusted', text: 'caution +0.03, depth −0.02' },
    ]);
    const err = cycleToWhy({
      botId: 'b1',
      cycle: { ...base, status: 'error', reason: 'Agent loop error: boom', reasonSource: 'error' },
    });
    expect(err.notes).toEqual([{ label: 'Error', text: 'Agent loop error: boom' }]);
  });

  it('an idle cycle without a recorded reason says so', () => {
    const w = cycleToWhy({ botId: 'b1', cycle: { ...base, status: 'idle' } });
    expect(w.missing).toContain('No reason was recorded');
  });
});

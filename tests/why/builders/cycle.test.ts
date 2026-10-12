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

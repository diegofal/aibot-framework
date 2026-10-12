import { describe, expect, it } from 'bun:test';
import { permissionOutcome, permissionToWhy } from '../../../src/why/builders/permission';
import type { CycleRow } from '../../../src/why/cycle-index';
import { WhySchema } from '../../../src/why/types';

const cycle: CycleRow = {
  cycleId: 'c-1',
  startedAt: '2026-10-11T12:00:00.000Z',
  endedAt: '2026-10-11T12:05:00.000Z',
  planSummary: 'Publish the release notes',
  goalId: 'g-1',
  goalTitle: 'Ship 2.0',
};

describe('permissionToWhy', () => {
  it('names the action, the cycle and goal that asked, and the agent request', () => {
    const why = permissionToWhy({
      botId: 'b1',
      action: 'exec',
      resource: 'rm -rf build/',
      description: 'Clean the stale build before publishing',
      cycleId: 'c-1',
      goalId: 'g-1',
      cycle,
    });
    expect(why).toEqual({
      what: 'It asked permission to exec on rm -rf build/',
      by: 'agent',
      cycle: {
        id: 'c-1',
        botId: 'b1',
        startedAt: '2026-10-11T12:00:00.000Z',
        plan: 'Publish the release notes',
      },
      goal: { id: 'g-1', title: 'Ship 2.0' },
      reason: { text: 'Clean the stale build before publishing', source: "Agent's request" },
      outcome: 'Waiting for your decision.',
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('an old request without a cycle says so', () => {
    const why = permissionToWhy({ botId: 'b1', action: 'exec', resource: 'ls', description: 'x' });
    expect(why.cycle).toBeUndefined();
    expect(why.missing).toContain('No record of the cycle that asked');
  });

  it('a cycle id the log does not have keeps the id and says the plan is unknown', () => {
    const why = permissionToWhy({
      botId: 'b1',
      action: 'exec',
      resource: 'ls',
      description: 'x',
      cycleId: 'c-gone',
    });
    expect(why.cycle).toEqual({ id: 'c-gone', botId: 'b1' });
    expect(why.missing).toContain('cycle log has no row');
  });

  it('drops empty parts', () => {
    const why = permissionToWhy({ botId: 'b1', action: '', resource: '', description: ' ' });
    expect(why.what).toBe('It asked permission to act');
    expect(why.reason).toBeUndefined();
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('history: the execution summary is the outcome, your note a note', () => {
    const why = permissionToWhy({
      botId: 'b1',
      action: 'exec',
      resource: 'ls',
      description: 'x',
      status: 'approved',
      executionStatus: 'executed',
      executionSummary: 'Listed the build dir and removed 3 stale files.',
      note: 'only build/',
    });
    expect(why.outcome).toBe(
      'You approved it and it acted: Listed the build dir and removed 3 stale files.'
    );
    expect(why.notes).toEqual([{ label: 'Your note', text: 'only build/' }]);
    expect(WhySchema.safeParse(why).success).toBe(true);
  });
});

describe('permissionOutcome', () => {
  it('says what happened at each step', () => {
    expect(permissionOutcome({})).toBe('Waiting for your decision.');
    expect(permissionOutcome({ status: 'denied', executionStatus: 'decided' })).toBe(
      'You denied it.'
    );
    expect(permissionOutcome({ status: 'approved', executionStatus: 'decided' })).toBe(
      'You approved it; its next cycle will act on it.'
    );
    expect(permissionOutcome({ status: 'approved', executionStatus: 'consumed' })).toBe(
      'You approved it; a cycle picked it up.'
    );
    expect(
      permissionOutcome({ status: 'approved', executionStatus: 'failed', executionSummary: 'boom' })
    ).toBe('You approved it, but acting on it failed: boom');
    expect(permissionOutcome({ status: 'approved', executionStatus: 'executed' })).toBe(
      'You approved it and it acted on it.'
    );
  });

  it('caps a long summary', () => {
    const out = permissionOutcome({
      status: 'approved',
      executionStatus: 'executed',
      executionSummary: 'a'.repeat(500),
    });
    expect(out.length).toBeLessThanOrEqual(260);
    expect(out.endsWith('…')).toBe(true);
  });
});

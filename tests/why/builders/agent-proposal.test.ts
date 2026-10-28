import { describe, expect, it } from 'bun:test';
import { agentProposalToWhy, proposalOutcome } from '../../../src/why/builders/agent-proposal';
import type { CycleRow } from '../../../src/why/cycle-index';
import { WhySchema } from '../../../src/why/types';

const cycle: CycleRow = {
  cycleId: 'c-1',
  startedAt: '2026-10-11T12:00:00.000Z',
  endedAt: '2026-10-11T12:05:00.000Z',
  planSummary: 'Find who could cover research',
  goalId: 'g-1',
  goalTitle: 'Grow the team',
};

const proposal = {
  proposedBy: 'b1',
  agentName: 'Scout',
  agentId: 'scout',
  justification: 'Nobody covers market research.',
  status: 'pending' as const,
};

describe('agentProposalToWhy', () => {
  it('names the cycle and goal that proposed it and the justification', () => {
    const why = agentProposalToWhy({
      proposal: { ...proposal, cycleId: 'c-1', goalId: 'g-1' },
      cycle,
    });
    expect(why).toEqual({
      what: 'It proposed a new agent: Scout',
      by: 'agent',
      cycle: {
        id: 'c-1',
        botId: 'b1',
        startedAt: '2026-10-11T12:00:00.000Z',
        plan: 'Find who could cover research',
      },
      goal: { id: 'g-1', title: 'Grow the team' },
      reason: { text: 'Nobody covers market research.', source: "Agent's justification" },
      outcome: 'Waiting for your decision.',
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('an old proposal without a cycle says so', () => {
    const why = agentProposalToWhy({ proposal });
    expect(why.cycle).toBeUndefined();
    expect(why.missing).toContain('No record of the cycle that proposed it');
  });

  it('a rejection keeps your note', () => {
    const why = agentProposalToWhy({
      proposal: { ...proposal, status: 'rejected', rejectionNote: 'Not now' },
    });
    expect(why.outcome).toBe('You rejected it.');
    expect(why.notes).toEqual([{ label: 'Your note', text: 'Not now' }]);
  });
});

describe('proposalOutcome', () => {
  it('reads the status', () => {
    expect(proposalOutcome({ status: 'pending' })).toBe('Waiting for your decision.');
    expect(proposalOutcome({ status: 'approved' })).toBe(
      'You approved it and the agent was created.'
    );
    expect(
      proposalOutcome({
        status: 'approved',
        approvalResult: {
          configCreated: true,
          soulGenerated: false,
          soulDir: 'x',
          error: 'LLM down',
        },
      })
    ).toBe('You approved it; the agent was created, but its soul failed: LLM down');
    expect(proposalOutcome({ status: 'rejected' })).toBe('You rejected it.');
  });
});

describe('agentProposalToWhy for a proposal of the mind', () => {
  it('is by the watcher, from the brief: the wants it serves, the kill criterion, no cycle missing', () => {
    const why = agentProposalToWhy({
      proposal: {
        ...proposal,
        proposedBy: '__watcher__',
        justification: 'Serves: roles.',
        serves: [{ id: 'w-aaaaaa', what: 'Five AI roles a week' }],
        killCriterion: 'Two lists with no role opened',
        mindObjective: 'check my hiring predictions',
      },
    });
    expect(why.by).toBe('watcher');
    expect(why.what).toBe('The mind proposed a new agent: Scout');
    expect(why.reason).toEqual({ text: 'Serves: roles.', source: "The mind's design" });
    expect(why.related).toEqual({
      label: 'Serves your brief',
      items: [{ text: 'Five AI roles a week' }],
    });
    expect(why.rule).toBe('Kill if: Two lists with no role opened');
    expect(why.notes).toEqual([{ label: 'For the mind', text: 'check my hiring predictions' }]);
    expect(why.cycle).toBeUndefined();
    expect(why.missing).toBeUndefined();
    expect(WhySchema.safeParse(why).success).toBe(true);
  });
});

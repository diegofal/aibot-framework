/**
 * Why for a `create_agent` proposal (Agent Proposals page, Needs You): the
 * cycle and goal that proposed it (recorded from the tool's `_cycleId` /
 * `_goalId`), the agent's justification, and what you decided.
 */
import type { AgentProposal } from '../../tools/agent-proposal-store';
import { type CycleRow, cycleAttribution } from '../cycle-index';
import type { Why } from '../types';

export type ProposalWhyFields = Pick<
  AgentProposal,
  'proposedBy' | 'agentName' | 'agentId' | 'justification' | 'status'
> &
  Partial<Pick<AgentProposal, 'cycleId' | 'goalId' | 'rejectionNote' | 'approvalResult'>>;

export interface AgentProposalWhyInput {
  proposal: ProposalWhyFields;
  /** The cycle-log row for `proposal.cycleId`, when the log has it. */
  cycle?: CycleRow;
}

const NO_CYCLE_TEXT =
  'No record of the cycle that proposed it: proposed outside a work cycle (a chat), or before proposals recorded it.';
const UNLOGGED_TEXT = 'The cycle log has no row for its cycle, so the plan and goal are unknown.';

export function proposalOutcome(
  p: Pick<ProposalWhyFields, 'status'> & Partial<Pick<ProposalWhyFields, 'approvalResult'>>
): string {
  if (p.status === 'rejected') return 'You rejected it.';
  if (p.status !== 'approved') return 'Waiting for your decision.';
  const err = p.approvalResult?.error?.trim();
  return err
    ? `You approved it; the agent was created, but its soul failed: ${err}`
    : 'You approved it and the agent was created.';
}

export function agentProposalToWhy({ proposal: p, cycle: row }: AgentProposalWhyInput): Why {
  const { cycle, goal, unlogged } = cycleAttribution(p.proposedBy, p, row);
  const name = (p.agentName ?? '').trim() || (p.agentId ?? '').trim();
  const why: Why = {
    what: name ? `It proposed a new agent: ${name}` : 'It proposed a new agent',
    by: 'agent',
  };
  if (cycle) why.cycle = cycle;
  if (goal) why.goal = goal;
  const reason = (p.justification ?? '').trim();
  if (reason) why.reason = { text: reason, source: "Agent's justification" };
  why.outcome = proposalOutcome(p);
  const note = (p.rejectionNote ?? '').trim();
  if (note) why.notes = [{ label: 'Your note', text: note }];
  if (!cycle) why.missing = NO_CYCLE_TEXT;
  else if (unlogged) why.missing = UNLOGGED_TEXT;
  return why;
}

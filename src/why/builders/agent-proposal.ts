/**
 * Why for a `create_agent` proposal (Agent Proposals page, Needs You): the
 * cycle and goal that proposed it (recorded from the tool's `_cycleId` /
 * `_goalId`), the agent's justification, and what you decided. A proposal of
 * the mind (`proposedBy: '__watcher__'`, `src/watcher/roster/`) has no cycle:
 * it comes from your brief, so Why shows the wants it serves and its kill
 * criterion instead.
 */
import type { AgentProposal } from '../../tools/agent-proposal-store';
import { WATCHER_PROPOSER } from '../../watcher/roster/types';
import { type CycleRow, cycleAttribution } from '../cycle-index';
import type { Why } from '../types';

export type ProposalWhyFields = Pick<
  AgentProposal,
  'proposedBy' | 'agentName' | 'agentId' | 'justification' | 'status'
> &
  Partial<
    Pick<
      AgentProposal,
      | 'cycleId'
      | 'goalId'
      | 'rejectionNote'
      | 'approvalResult'
      | 'serves'
      | 'killCriterion'
      | 'mindObjective'
    >
  >;

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

function mindProposalToWhy(p: ProposalWhyFields, name: string): Why {
  const why: Why = {
    what: name ? `The mind proposed a new agent: ${name}` : 'The mind proposed a new agent',
    by: 'watcher',
  };
  const reason = (p.justification ?? '').trim();
  if (reason) why.reason = { text: reason, source: "The mind's design" };
  const kill = (p.killCriterion ?? '').trim();
  if (kill) why.rule = `Kill if: ${kill}`;
  const serves = (p.serves ?? []).filter((s) => s.what?.trim());
  if (serves.length)
    why.related = { label: 'Serves your brief', items: serves.map((s) => ({ text: s.what })) };
  why.outcome = proposalOutcome(p);
  const notes: NonNullable<Why['notes']> = [];
  const mind = (p.mindObjective ?? '').trim();
  if (mind) notes.push({ label: 'For the mind', text: mind });
  const note = (p.rejectionNote ?? '').trim();
  if (note) notes.push({ label: 'Your note', text: note });
  if (notes.length) why.notes = notes;
  return why;
}

export function agentProposalToWhy({ proposal: p, cycle: row }: AgentProposalWhyInput): Why {
  if (p.proposedBy === WATCHER_PROPOSER)
    return mindProposalToWhy(p, (p.agentName ?? '').trim() || (p.agentId ?? '').trim());
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

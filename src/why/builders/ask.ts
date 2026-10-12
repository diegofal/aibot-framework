/**
 * Why for an ask_human question (Needs You and the inbox thread): the cycle
 * that asked it (`PendingQuestion.cycleId` / `Conversation.cycleId`), that
 * cycle's plan and goal from the cycle log, and what happened to it.
 */
import type { InboxStatus } from '../../conversations/service';
import { type CycleRow, cycleAttribution } from '../cycle-index';
import type { Why } from '../types';

export interface AskWhyInput {
  botId: string;
  cycleId?: string | null;
  goalId?: string | null;
  /** The cycle-log row for `cycleId`, when the log has it. */
  cycle?: CycleRow;
  /** The inbox thread's status; absent = a live question still waiting. */
  status?: InboxStatus;
}

const OUTCOME_TEXT: Record<InboxStatus, string> = {
  pending: 'Waiting for your answer.',
  answered: 'You answered it.',
  dismissed: 'You dismissed it without answering.',
  timed_out: 'It timed out without an answer.',
  closed: 'Closed.',
};

export const NO_CYCLE_TEXT =
  'No record of a work cycle: written outside one (a chat or a scheduled job), or before cycles were recorded.';
export const UNLOGGED_CYCLE_TEXT =
  'The cycle log has no row for its cycle, so the plan and goal are unknown.';

export function askOutcome(status: InboxStatus | undefined): string {
  return OUTCOME_TEXT[status ?? 'pending'] ?? OUTCOME_TEXT.pending;
}

export function askToWhy(a: AskWhyInput): Why {
  const { cycle, goal, unlogged } = cycleAttribution(a.botId, a, a.cycle);
  const why: Why = {
    what: cycle ? 'A question it asked you during a work cycle' : 'A question it asked you',
    by: 'agent',
  };
  if (cycle) why.cycle = cycle;
  if (goal) why.goal = goal;
  why.outcome = askOutcome(a.status);
  if (!cycle) why.missing = NO_CYCLE_TEXT;
  else if (unlogged) why.missing = UNLOGGED_CYCLE_TEXT;
  return why;
}

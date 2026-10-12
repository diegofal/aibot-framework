/**
 * Why for a piece of operator feedback (feedback page, Needs You replies):
 * it is yours, and the agent-loop cycle that handled it (`markApplied`
 * records the cycle id), or that it has not been handled yet.
 */
import type { AgentFeedback } from '../../bot/agent-feedback-store';
import { type CycleRow, cycleAttribution } from '../cycle-index';
import type { Why } from '../types';

export interface FeedbackWhyInput {
  botId: string;
  status: AgentFeedback['status'];
  appliedAt?: string;
  cycleId?: string | null;
  /** The cycle-log row for `cycleId`, when the log has it. */
  cycle?: CycleRow;
}

const NO_CYCLE_TEXT =
  'No record of the cycle that handled it: handled before feedback recorded its cycle.';
const UNLOGGED_TEXT = 'The cycle log has no row for its cycle, so its plan is unknown.';

export function feedbackToWhy(f: FeedbackWhyInput): Why {
  const why: Why = { what: 'Your feedback', by: 'operator' };
  if (f.status === 'pending') {
    why.outcome = 'Not handled yet.';
    return why;
  }
  if (f.status === 'dismissed') {
    why.outcome = 'You dismissed it.';
    return why;
  }
  // The cycle's goal is what the cycle served, not what the feedback was about: only the cycle.
  const { cycle, unlogged } = cycleAttribution(f.botId, { cycleId: f.cycleId }, f.cycle);
  if (cycle) why.cycle = cycle;
  why.outcome = cycle ? 'Handled in a cycle.' : 'Handled.';
  if (!cycle) why.missing = NO_CYCLE_TEXT;
  else if (unlogged) why.missing = UNLOGGED_TEXT;
  return why;
}

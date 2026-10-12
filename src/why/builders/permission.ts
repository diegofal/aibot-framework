/**
 * Why for an ask_permission request (Needs You, the Permissions page and its
 * history): the action, the cycle and goal that asked (recorded by the store
 * from the tool's `_cycleId` / `_goalId`), the agent's stated reason, and
 * what happened to it — the execution summary once a cycle acted on it.
 */
import { type CycleRow, cycleAttribution } from '../cycle-index';
import type { Why } from '../types';

export interface PermissionWhyInput {
  botId: string;
  action: string;
  resource: string;
  /** The tool's `description` parameter: the agent's reason. */
  description: string;
  cycleId?: string | null;
  goalId?: string | null;
  /** The cycle-log row for `cycleId`, when the log has it. */
  cycle?: CycleRow;
  /** Absent = still pending. */
  status?: 'pending' | 'approved' | 'denied';
  executionStatus?: 'decided' | 'consumed' | 'executed' | 'failed';
  executionSummary?: string;
  /** The operator's note on the decision. */
  note?: string;
}

export const PERMISSION_NO_CYCLE_TEXT =
  'No record of the cycle that asked: requested outside a work cycle (a chat), or before requests recorded it.';
const UNLOGGED_TEXT = 'The cycle log has no row for its cycle, so the plan and goal are unknown.';

const SUMMARY_MAX = 220;
const clip = (s: string) => (s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s);

/** What happened to a request, in one sentence; the execution summary once it ran. */
export function permissionOutcome(
  p: Pick<PermissionWhyInput, 'status' | 'executionStatus' | 'executionSummary'>
): string {
  if (!p.status || p.status === 'pending') return 'Waiting for your decision.';
  if (p.status === 'denied') return 'You denied it.';
  const summary = (p.executionSummary ?? '').trim();
  switch (p.executionStatus) {
    case 'consumed':
      return 'You approved it; a cycle picked it up.';
    case 'executed':
      return summary
        ? `You approved it and it acted: ${clip(summary)}`
        : 'You approved it and it acted on it.';
    case 'failed':
      return summary
        ? `You approved it, but acting on it failed: ${clip(summary)}`
        : 'You approved it, but acting on it failed.';
    default:
      return 'You approved it; its next cycle will act on it.';
  }
}

export function permissionToWhy(p: PermissionWhyInput): Why {
  const action = (p.action ?? '').trim();
  const resource = (p.resource ?? '').trim();
  const reason = (p.description ?? '').trim();
  const { cycle, goal, unlogged } = cycleAttribution(p.botId, p, p.cycle);
  const why: Why = {
    what: action
      ? `It asked permission to ${action}${resource ? ` on ${resource}` : ''}`
      : 'It asked permission to act',
    by: 'agent',
  };
  if (cycle) why.cycle = cycle;
  if (goal) why.goal = goal;
  if (reason) why.reason = { text: reason, source: "Agent's request" };
  why.outcome = permissionOutcome(p);
  const note = (p.note ?? '').trim();
  if (note) why.notes = [{ label: 'Your note', text: note }];
  if (!cycle) why.missing = PERMISSION_NO_CYCLE_TEXT;
  else if (unlogged) why.missing = UNLOGGED_TEXT;
  return why;
}

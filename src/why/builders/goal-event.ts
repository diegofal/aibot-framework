/**
 * Why for one change in a goal's timeline (the goal drawer): the op in words,
 * who made it (`goal-events.jsonl` actor), the cycle it happened in with that
 * cycle's plan, and from → to. Reasons for goal changes are not recorded yet
 * (plan row 12), so `reason` stays empty rather than guessed.
 */
import { type CycleRow, toWhyCycle } from '../cycle-index';
import type { Why, WhyActor } from '../types';

export interface GoalEventWhyInput {
  botId: string;
  event: {
    ts: string;
    op: string;
    from: string | null;
    to: string | null;
    actor: string | null;
    cycleId?: string | null;
    /** Reconstructed from a manage_goals call in the tool audit. */
    inferred: boolean;
    note?: string | null;
  };
  /** The cycle-log row of `event.cycleId`, when the log still has it. */
  cycle?: CycleRow;
}

/**
 * Goal-event actors → Why actors. The wizard writes the goals the operator
 * typed when creating the agent, so it reads as the operator; `tool` (a
 * manage_goals call) is the agent; `unknown` says nothing.
 */
const ACTORS: Record<string, WhyActor> = {
  agent: 'agent',
  tool: 'agent',
  strategist: 'strategist',
  curiosity: 'curiosity',
  reflection: 'reflection',
  lint: 'lint',
  operator: 'operator',
  wizard: 'operator',
};

/** Actors that only act inside an agent-loop cycle. */
const LOOP_ACTORS = new Set<WhyActor>(['agent', 'strategist', 'curiosity', 'reflection']);

export function goalActorToWhy(actor: string | null | undefined): WhyActor | undefined {
  return actor ? ACTORS[actor] : undefined;
}

const STATUS_TEXT: Record<string, string> = {
  pending: 'To do',
  todo: 'To do',
  in_progress: 'In progress',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  completed: 'Done',
};

const status = (s: string) => STATUS_TEXT[s] ?? s;

const OP_TEXT: Record<string, string> = {
  add: 'Goal added',
  complete: 'Completed',
  reopen: 'Reopened',
  remove: 'Removed',
  priority: 'Priority changed',
  notes: 'Notes edited',
  title: 'Renamed',
  headline: 'Short title changed',
  tasks: 'Subtasks updated',
};

function whatOf(op: string, to: string | null): string {
  if (op === 'status') return to ? `Moved to ${status(to)}` : 'Status changed';
  return OP_TEXT[op] ?? `Changed (${op})`;
}

function outcomeOf(op: string, from: string | null, to: string | null): string | undefined {
  if (!from && !to) return undefined;
  const isStatus = op === 'status' || op === 'add' || op === 'complete' || op === 'reopen';
  const fmt = (s: string) => (isStatus ? status(s) : s);
  if (!from) return op === 'add' ? `Added as ${fmt(to as string)}` : `Now ${fmt(to as string)}`;
  if (!to) return `Was ${fmt(from)}`;
  return `${fmt(from)} → ${fmt(to)}${op === 'tasks' ? ' subtasks done' : ''}`;
}

export function goalEventToWhy(input: GoalEventWhyInput): Why {
  const { botId, event: e } = input;
  const why: Why = { what: whatOf(e.op, e.to) };
  const by = goalActorToWhy(e.actor);
  if (by) why.by = by;
  const missing: string[] = [];
  if (e.cycleId) {
    why.cycle = input.cycle ? toWhyCycle(botId, input.cycle) : { id: e.cycleId, botId };
    if (!input.cycle)
      missing.push('The cycle log has no record of this cycle, so its plan is unknown.');
  }
  if (e.inferred) {
    missing.push(
      'Reconstructed from a manage_goals call in the tool audit: the goal-event log did not exist yet.'
    );
  } else if (!e.cycleId && by && LOOP_ACTORS.has(by)) {
    missing.push('No cycle was recorded with this change (written before cycles were logged).');
  }
  const outcome = outcomeOf(e.op, e.from, e.to);
  if (outcome) why.outcome = outcome;
  if (e.note) why.notes = [{ label: 'Notes', text: e.note }];
  if (missing.length > 0) why.missing = missing.join(' ');
  return why;
}

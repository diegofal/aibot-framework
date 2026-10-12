/**
 * Why for one task-store change (a `task-*` row of `goal-events.jsonl`): what
 * happened to which task, who did it (the agent, a worker run, you, or the
 * system's housekeeping), the cycle it happened in, from → to, and the note
 * given with it. Used by the goal drawer's timeline for task rows.
 */
import { type CycleRow, toWhyCycle } from '../cycle-index';
import type { Why, WhyActor } from '../types';

export interface TaskEventWhyInput {
  botId: string;
  event: {
    ts: string;
    op: string;
    from: string | null;
    to: string | null;
    actor: string | null;
    cycleId?: string | null;
    /** The worker run behind the op (claims, releases, a worker's moves). */
    runId?: string | null;
    taskId?: string | null;
    /** The task's text at the time. */
    task?: string | null;
    note?: string | null;
  };
  /** The goal the task belongs to (omit where the page already shows it). */
  goal?: { id?: string; title: string };
  /** The cycle-log row of `event.cycleId`, when the log still has it. */
  cycle?: CycleRow;
}

const LANE_TEXT: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};
const lane = (s: string) => LANE_TEXT[s] ?? s;

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function whatOf(op: string, to: string | null, task: string, actor: string | null): string {
  const t = task ? `"${clip(task)}"` : 'a task';
  switch (op) {
    case 'task-add':
      return `Task added: ${t}`;
    case 'task-move':
      return to ? `Task moved to ${lane(to)}: ${t}` : `Task moved: ${t}`;
    case 'task-edit':
      return `Task renamed: ${t}`;
    case 'task-note':
      return `Task note: ${t}`;
    case 'task-remove':
      return `Task removed: ${t}`;
    case 'task-reorder':
      return 'Tasks reordered';
    case 'task-claim':
      return `A worker run picked up ${t}`;
    case 'task-release':
      return actor === 'operator'
        ? `You took ${t} back from a worker run`
        : `A worker run let go of ${t}`;
    default:
      return `Task changed (${op}): ${t}`;
  }
}

/** A worker run is the agent working; system ops without a run are housekeeping. */
function byOf(actor: string | null, runId: string | null | undefined): WhyActor | undefined {
  if (actor === 'operator') return 'operator';
  if (actor === 'agent') return 'agent';
  if (actor === 'system') return runId ? 'agent' : 'system';
  return undefined;
}

function outcomeOf(op: string, from: string | null, to: string | null): string | undefined {
  if (op === 'task-edit' || op === 'task-reorder') return undefined;
  if (!from && !to) return undefined;
  if (!from)
    return op === 'task-add' ? `Added as ${lane(to as string)}` : `Now ${lane(to as string)}`;
  if (!to) return `Was ${lane(from)}`;
  if (from === to) return `Stays ${lane(to)}`;
  return `${lane(from)} → ${lane(to)}`;
}

export function taskEventToWhy(input: TaskEventWhyInput): Why {
  const { botId, event: e } = input;
  const why: Why = { what: whatOf(e.op, e.to, (e.task ?? '').trim(), e.actor) };
  const by = byOf(e.actor, e.runId);
  if (by) why.by = by;
  if (input.goal?.title) why.goal = input.goal;
  if (e.cycleId) {
    why.cycle = input.cycle ? toWhyCycle(botId, input.cycle) : { id: e.cycleId, botId };
    if (!input.cycle)
      why.missing = 'The cycle log has no record of this cycle, so its plan is unknown.';
  }
  const outcome = outcomeOf(e.op, e.from, e.to);
  if (outcome) why.outcome = outcome;
  const notes: Array<{ label: string; text: string }> = [];
  if (e.taskId) notes.push({ label: 'Task', text: e.taskId });
  if (e.note?.trim()) notes.push({ label: 'Note', text: e.note.trim() });
  if (e.runId) notes.push({ label: 'Worker run', text: e.runId });
  if (notes.length > 0) why.notes = notes;
  return why;
}

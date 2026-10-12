/**
 * Why for one task worker run (`WorkerRunView` + its journal): who dispatched
 * it (the cycle — "Open cycle" via `dispatchCycleId` — or you), the task and
 * goal, the steps it took (journal `step-end` summaries), its last report,
 * the outcome (or where it is now) and the budget used. Built only from the
 * run record and its journal.
 */
import type { JournalEntry, WorkerOutcomeKind, WorkerRunView } from '../../workers/types';
import { type CycleRow, toWhyCycle } from '../cycle-index';
import type { Why, WhyRelatedItem } from '../types';

export interface WorkerRunWhyInput {
  run: WorkerRunView;
  /** The run's journal, when read. */
  journal?: JournalEntry[];
  /** The cycle-log row of `run.dispatchCycleId`, when the log still has it. */
  cycle?: CycleRow;
}

/** At most this many steps listed. */
const STEPS_MAX = 12;

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const OUTCOME_TEXT: Record<WorkerOutcomeKind, string> = {
  done: 'Done',
  blocked: 'Blocked',
  budget: 'Stopped at its budget',
  failed: 'Failed',
  stopped: 'Stopped',
  protocol: 'Ended for breaking the step protocol',
  interrupted: 'Interrupted by a restart',
};

const REPORT_TEXT = { progress: 'Progress', done: 'Done', blocked: 'Blocked' } as const;

function nowText(run: WorkerRunView): string {
  switch (run.status) {
    case 'queued':
      return 'Queued, not started yet';
    case 'running':
      return `Running, step ${run.step + 1}${run.currentTool ? ` (${run.currentTool})` : ''}`;
    case 'waiting':
      return run.wait
        ? `Waiting for your ${run.wait.kind === 'ask' ? 'answer' : 'approval'}: ${run.wait.question}`
        : 'Waiting';
    case 'interrupted':
      return 'Interrupted by a restart; it resumes at its last finished step';
    default:
      return run.error ? `${run.status}: ${run.error}` : run.status;
  }
}

function budgetText(run: WorkerRunView): string {
  const min = (ms: number) => Math.round(ms / 60_000);
  return [
    `${run.used.steps} of ${run.budget.steps} steps`,
    `${run.used.toolCalls} of ${run.budget.toolCalls} tool calls`,
    `${min(run.used.wallMs)} of ${min(run.budget.wallMs)} min`,
  ].join(' · ');
}

function stepsOf(journal: JournalEntry[] | undefined): Why['related'] {
  const ends = (journal ?? []).filter(
    (e): e is Extract<JournalEntry, { kind: 'step-end' }> => e.kind === 'step-end'
  );
  if (ends.length === 0) return undefined;
  const items: WhyRelatedItem[] = ends.slice(-STEPS_MAX).map((e) => {
    const item: WhyRelatedItem = {
      text: `Step ${e.n}: ${clip(e.summary?.trim() || '(no summary)', 160)}`,
      at: e.ts,
    };
    if (e.error) item.detail = e.error;
    return item;
  });
  return {
    label: 'Steps',
    items,
    ...(ends.length > STEPS_MAX ? { note: `Last ${STEPS_MAX} of ${ends.length} steps.` } : {}),
  };
}

export function workerRunToWhy(input: WorkerRunWhyInput): Why {
  const { run } = input;
  const why: Why = {
    what: `A worker run on "${clip(run.taskText || run.taskId)}"`,
    by: run.dispatchCycleId ? 'agent' : 'operator',
  };
  if (run.dispatchCycleId) {
    why.cycle = input.cycle
      ? toWhyCycle(run.botId, input.cycle)
      : { id: run.dispatchCycleId, botId: run.botId };
    if (!input.cycle)
      why.missing = 'The cycle log has no record of this cycle, so its plan is unknown.';
  } else {
    why.rule = 'You started this run from the dashboard (or retried an earlier one).';
  }
  if (run.goalTitle) why.goal = { ...(run.goalId ? { id: run.goalId } : {}), title: run.goalTitle };
  const steps = stepsOf(input.journal);
  if (steps) why.related = steps;
  why.outcome = run.outcome
    ? `${OUTCOME_TEXT[run.outcome.kind] ?? run.outcome.kind}${run.outcome.note?.trim() ? `: ${run.outcome.note.trim()}` : ''}`
    : nowText(run);

  const notes: Array<{ label: string; text: string }> = [];
  if (run.lastReport && !(run.outcome && run.outcome.note === run.lastReport.note))
    notes.push({
      label: 'Last report',
      text: `${REPORT_TEXT[run.lastReport.kind]}: ${run.lastReport.note}`,
    });
  notes.push({ label: 'Budget used', text: budgetText(run) });
  notes.push({ label: 'Task', text: run.taskId });
  notes.push({ label: 'Run', text: `${run.runId} (attempt ${run.attempt})` });
  why.notes = notes;
  return why;
}

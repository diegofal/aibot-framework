/**
 * The three worker report tools (plan C11): the only way a worker step ends.
 * `task_progress(note)` records progress and the run goes on;
 * `task_done(note)` and `task_blocked(why)` also move the task (TaskStore
 * `release` with the run's claim token) and end the run.
 * One report per step: a second call in the same step is refused.
 */
import type { TaskLane } from '../goals/task-store';
import type { Tool, ToolResult } from '../tools/types';
import type { StepReport, WorkerReportTool } from './types';

export const REPORT_NOTE_MAX = 200;

export interface ReportToolsDeps {
  /** Whether this step already reported. */
  hasReported(): boolean;
  /** Record the step's report. */
  onReport(report: StepReport): void;
  /** Move the task out of the run's claim (done → Done, blocked → Blocked). */
  release(lane: TaskLane, note: string): { ok: boolean; message?: string };
}

const KIND: Record<WorkerReportTool, StepReport['kind']> = {
  task_progress: 'progress',
  task_done: 'done',
  task_blocked: 'blocked',
};

const DESCRIPTIONS: Record<WorkerReportTool, { text: string; arg: string; argText: string }> = {
  task_progress: {
    text: 'End this step: what you did and what is next. The task stays yours; the next step continues from this note.',
    arg: 'note',
    argText: 'What this step did and what the next step should do (one or two sentences).',
  },
  task_done: {
    text: 'The task is finished. Moves it to Done and ends your run. Say what you produced and where.',
    arg: 'note',
    argText: 'What was done and where the result is (file path, link).',
  },
  task_blocked: {
    text: 'You cannot go on without someone else. Moves the task to Blocked and ends your run.',
    arg: 'why',
    argText: 'What blocks the task and what would unblock it.',
  },
};

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > REPORT_NOTE_MAX ? `${t.slice(0, REPORT_NOTE_MAX - 1)}…` : t;
}

export function isReportTool(name: string): name is WorkerReportTool {
  return name in KIND;
}

export function createReportTools(deps: ReportToolsDeps): Tool[] {
  return (Object.keys(KIND) as WorkerReportTool[]).map((name) => {
    const d = DESCRIPTIONS[name];
    return {
      definition: {
        type: 'function',
        function: {
          name,
          description: d.text,
          parameters: {
            type: 'object',
            properties: { [d.arg]: { type: 'string', description: d.argText } },
            required: [d.arg],
          },
        },
      },
      execute: async (args): Promise<ToolResult> => {
        const raw = args[d.arg];
        const note = typeof raw === 'string' ? clip(raw) : '';
        if (!note) return { success: false, content: `${name} needs a "${d.arg}".` };
        if (deps.hasReported())
          return {
            success: false,
            content: 'This step already reported. End your turn now.',
          };
        const kind = KIND[name];
        if (kind !== 'progress') {
          const moved = deps.release(kind === 'done' ? 'done' : 'blocked', note);
          if (!moved.ok) {
            // The claim is gone (the operator moved the task): the report still
            // ends the step, and the run with it.
            deps.onReport({ kind, note });
            return {
              success: false,
              content: `Recorded, but the task could not be moved: ${moved.message ?? 'claim lost'}. End your turn.`,
            };
          }
        }
        deps.onReport({ kind, note });
        return {
          success: true,
          content:
            kind === 'progress'
              ? 'Progress recorded. End your turn now; the next step continues from your note.'
              : `Task marked ${kind}. End your turn now.`,
        };
      },
    } satisfies Tool;
  });
}

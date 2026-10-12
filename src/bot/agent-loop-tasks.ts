/**
 * The planner's task fields (goal tasks plan, phase 1, C8): the prompt blocks
 * that ask for them, their parsing, and the loop step that acts on them.
 *
 * D2: the planner chooses; the loop and the worker pool act. The loop writes
 * `new_tasks` and dispatches only what the planner named explicitly, never on
 * explore, idle or engagement-gated cycles, and never a content task while
 * the hard engagement gate is on.
 */
import { type StoredTask, TASK_TEXT_MAX, type TaskStore, liveClaim } from '../goals/task-store';
import { type GoalEntry, resolveGoalRef } from '../tools/goals';
import type {
  DispatchResult,
  PlannerTaskFields,
  WorkerPoolApi,
  WorkerRunView,
} from '../workers/types';
import { isActiveRun } from '../workers/types';
import { classifyAction } from './agent-loop-utils';

/** At most this many tasks per `new_tasks` (the prompt asks for 2–5). */
export const NEW_TASKS_MAX = 5;
/** At most this many ids per `dispatch`. */
export const DISPATCH_MAX = 5;
/** Ended runs the planner's Workers block may show. */
export const WORKERS_ENDED_LIMIT = 10;
/** Without a previous cycle in memory, ended runs of the last day are "since the previous cycle". */
export const WORKERS_ENDED_FALLBACK_MS = 24 * 3_600_000;

// ── Prompt ───────────────────────────────────────────────────────────────

/** What the planner prompt gets about workers; absent = workers off for the bot. */
export interface PlannerWorkersInput {
  /** `WorkerPoolApi.list(botId, { endedLimit })`: active runs plus recently ended ones. */
  runs: WorkerRunView[];
  /** Ended runs are shown only when they ended at or after this instant (the previous cycle). */
  endedSinceMs?: number;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function runLine(r: WorkerRunView): string {
  const head = `- ${r.taskId} "${oneLine(r.taskText, 80)}"`;
  if (isActiveRun(r.status)) {
    let line = `${head} — ${r.status}, step ${r.step}/${r.budget.steps}`;
    if (r.status === 'waiting' && r.wait)
      line += ` — waiting on your operator: ${oneLine(r.wait.question, 120)}`;
    if (r.lastReport)
      line += ` — last report (${r.lastReport.kind}): ${oneLine(r.lastReport.note, 160)}`;
    return line;
  }
  const outcome = r.outcome ? `${r.outcome.kind}: ${oneLine(r.outcome.note, 160)}` : r.status;
  return `${head} — ${outcome}`;
}

/** "## Workers": runs that are going and runs that ended since the previous cycle. */
export function buildWorkersSection(input: PlannerWorkersInput): string {
  const active = input.runs.filter((r) => isActiveRun(r.status));
  const since = input.endedSinceMs ?? Number.NEGATIVE_INFINITY;
  const ended = input.runs.filter((r) => {
    if (isActiveRun(r.status)) return false;
    const at = Date.parse(r.endedAt ?? '');
    return Number.isFinite(at) ? at >= since : false;
  });
  const lines = ['## Workers', ''];
  lines.push(
    'Workers are background runs of you, each working one task of a goal step by step. They report when they finish or get stuck.'
  );
  if (active.length === 0 && ended.length === 0) {
    lines.push('', 'No worker is running and none ended since your last cycle.');
    return lines.join('\n');
  }
  if (active.length > 0) lines.push('', 'Working now:', ...active.map(runLine));
  if (ended.length > 0) lines.push('', 'Ended since your last cycle:', ...ended.map(runLine));
  lines.push(
    '',
    'A task a worker holds is not yours this cycle: do not work it and do not dispatch it again. Read what ended: note or move its task, or break the goal down further.'
  );
  return lines.join('\n');
}

/** "## Tasks": how to break a goal down, name the served task and (with workers) dispatch. */
export function buildTaskOutputSection(opts: { workersEnabled: boolean }): string {
  const lines = [
    '## Tasks',
    '',
    'Goals list their open tasks with ids (t-…). Tasks are the steps of a goal and outlive this cycle; they are different from your plan steps.',
    '- BREAK A GOAL DOWN: when the goal you will work on has no open task, add "new_tasks": {"goal": "<goal id or exact title>", "tasks": [2–5 concrete, verifiable steps]}. One line each; each names a result someone could check (a file written, a message sent, a decision recorded). Only that one goal, and only when it has no open task.',
    '- "serves_task": the id of the open task your own plan works on, when it works on one.',
  ];
  if (opts.workersEnabled) {
    lines.push(
      '- "dispatch": ["t-…"] — open tasks to hand to workers, who work them in the background while you do something else. Only tasks no worker holds (see Workers). A task you add in new_tasks this cycle may be named by its exact text. Do not dispatch the task your own plan serves.'
    );
  }
  return lines.join('\n');
}

/** The JSON Schema lines for the task fields. */
export function buildTaskSchemaLines(opts: { workersEnabled: boolean }): string {
  const lines = [
    '- new_tasks: {"goal": string, "tasks": array of 2-5 strings} (optional — only for a goal with no open task)',
    '- serves_task: string, the id of the open task your plan works on (optional)',
  ];
  if (opts.workersEnabled) {
    lines.push(
      '- dispatch: array of open task ids to hand to workers (optional). plan may be an empty array when you only dispatch tasks (or only break a goal down with new_tasks) and do no work of your own this cycle; such an answer still needs priority "low" or higher (priority "none" is idle and writes nothing)'
    );
  }
  return lines.join('\n');
}

// ── Parsing ──────────────────────────────────────────────────────────────

const cleanLine = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  if (/[\r\n]/.test(v.trim())) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t || t.length > TASK_TEXT_MAX) return null;
  return t;
};

/**
 * The optional task fields of a planner answer, shapes validated: `new_tasks`
 * needs a goal and at least one single-line task of ≤ 200 chars (capped at 5);
 * `dispatch` keeps unique non-empty strings (capped at 5); `serves_task` a
 * non-empty string. Junk is dropped, never an error.
 */
export function parsePlannerTaskFields(parsed: Record<string, unknown>): PlannerTaskFields {
  const out: PlannerTaskFields = {};
  const nt = parsed.new_tasks;
  if (nt && typeof nt === 'object' && !Array.isArray(nt)) {
    const rec = nt as Record<string, unknown>;
    const goal = typeof rec.goal === 'string' ? rec.goal.trim() : '';
    const tasks = Array.isArray(rec.tasks)
      ? rec.tasks
          .map(cleanLine)
          .filter((t): t is string => t !== null)
          .slice(0, NEW_TASKS_MAX)
      : [];
    if (goal && tasks.length > 0) out.new_tasks = { goal, tasks };
  }
  if (Array.isArray(parsed.dispatch)) {
    const ids = [
      ...new Set(parsed.dispatch.map(cleanLine).filter((t): t is string => t !== null)),
    ].slice(0, DISPATCH_MAX);
    if (ids.length > 0) out.dispatch = ids;
  }
  const serves = cleanLine(parsed.serves_task);
  if (serves) out.serves_task = serves;
  return out;
}

// ── Loop ─────────────────────────────────────────────────────────────────

/**
 * Pending questions that belong to the cycle: a question a worker run asked
 * carries its `runId` (phase 2b) and shows in the Workers block as that run's
 * wait, so the planner does not see it twice or act on it.
 */
export function cyclePendingQuestions<T extends object>(questions: T[]): T[] {
  return questions.filter((q) => !(q as { runId?: string }).runId);
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** An open task by id, else by exact text (whitespace and case ignored). */
export function resolveTaskRef(ref: string | undefined, tasks: StoredTask[]): StoredTask | null {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  const open = tasks.filter((t) => t.lane !== 'done');
  const byId = open.find((t) => t.id === r);
  if (byId) return byId;
  const key = norm(r);
  return open.find((t) => norm(t.text) === key) ?? null;
}

/** One dispatch decision as the cycle row keeps it. */
export interface CycleDispatch {
  taskId: string;
  runId?: string;
  ok: boolean;
  reason?: string;
}

export interface ApplyPlannerTasksInput {
  botId: string;
  cycleId: string;
  fields: PlannerTaskFields;
  store: Pick<TaskStore, 'apply' | 'list'> | null | undefined;
  /** Active goals. */
  goals: GoalEntry[];
  workerPool?: WorkerPoolApi;
  /** Explore cycle (curiosity). */
  exploring: boolean;
  /** Empty plan or priority none. */
  idle: boolean;
  /** The hard engagement gate turned the plan down. */
  gateBlocked: boolean;
  /** The hard engagement gate is on (content held back), even if this plan passed. */
  hardGateActive: boolean;
  /**
   * Give goals written before ids their id (a rewrite of GOALS.md does) and
   * return the fresh active goals. Used when `new_tasks` names a goal with no id.
   */
  assignGoalIds?: () => GoalEntry[] | null | undefined;
  logger?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  nowMs?: number;
}

export interface ApplyPlannerTasksResult {
  /** Ids of the tasks `new_tasks` wrote (or matched as near-duplicates). */
  newTaskIds: string[];
  dispatched: CycleDispatch[];
  /** The open task the cycle's own work serves. */
  servesTask?: { id: string; text: string; goalId: string };
  /** Why nothing was done (explore / idle / gated). */
  skipped?: 'explore' | 'idle' | 'gated';
}

/**
 * Act on the planner's task fields: write `new_tasks` as the agent, dispatch
 * the named open tasks (when workers are on for the bot) and resolve the task
 * the cycle's own work serves. Never waits for a run; never throws.
 */
export function applyPlannerTasks(input: ApplyPlannerTasksInput): ApplyPlannerTasksResult {
  const { fields, botId, cycleId, logger } = input;
  const result: ApplyPlannerTasksResult = { newTaskIds: [], dispatched: [] };
  const skipped: ApplyPlannerTasksResult['skipped'] = input.gateBlocked
    ? 'gated'
    : input.idle
      ? 'idle'
      : input.exploring
        ? 'explore'
        : undefined;
  if (skipped) {
    if (fields.new_tasks || fields.dispatch) {
      logger?.info({ botId, cycleId, skipped }, 'Planner tasks: not acted on in this cycle');
    }
    result.skipped = skipped;
    return result;
  }
  const store = input.store;
  if (!store) return result;
  const nowMs = input.nowMs ?? Date.now();
  const list = (): StoredTask[] => {
    try {
      return store.list();
    } catch {
      return [];
    }
  };

  // 1. new_tasks
  const added: StoredTask[] = [];
  if (fields.new_tasks) {
    let goal = resolveGoalRef(fields.new_tasks.goal, input.goals);
    if (goal && !goal.id && input.assignGoalIds) {
      try {
        const fresh = input.assignGoalIds() ?? [];
        goal =
          resolveGoalRef(fields.new_tasks.goal, fresh) ??
          fresh.find((g) => g.text.trim() === goal?.text.trim()) ??
          goal;
      } catch (err) {
        logger?.warn({ botId, err }, 'Planner tasks: could not assign goal ids');
      }
    }
    if (!goal?.id) {
      logger?.warn(
        { botId, goal: fields.new_tasks.goal },
        'Planner tasks: new_tasks names no active goal'
      );
    } else if (list().some((t) => t.goalId === goal.id && t.lane !== 'done')) {
      logger?.info(
        { botId, goalId: goal.id },
        'Planner tasks: goal already has open tasks; new_tasks skipped'
      );
    } else {
      for (const text of fields.new_tasks.tasks) {
        try {
          const res = store.apply([{ op: 'add', goalId: goal.id, text }], {
            actor: 'agent',
            cycleId,
          });
          if (!res.ok) {
            logger?.warn(
              { botId, reason: res.reason, message: res.message },
              'Planner tasks: add refused'
            );
            if (res.reason === 'cap') break;
            continue;
          }
          const id = res.results[0]?.id;
          if (id && !result.newTaskIds.includes(id)) result.newTaskIds.push(id);
        } catch (err) {
          logger?.warn({ botId, err }, 'Planner tasks: add failed');
        }
      }
      const now = list();
      for (const id of result.newTaskIds) {
        const t = now.find((x) => x.id === id);
        if (t) added.push(t);
      }
      logger?.info(
        { botId, goalId: goal.id, tasks: result.newTaskIds },
        'Planner tasks: goal broken down'
      );
    }
  }

  const tasks = list();
  const resolve = (ref: string) => resolveTaskRef(ref, added) ?? resolveTaskRef(ref, tasks);

  // 2. dispatch
  const pool = input.workerPool;
  const dispatchedOk = new Set<string>();
  if (fields.dispatch && pool) {
    let enabled = false;
    try {
      enabled = pool.isEnabledFor(botId);
    } catch {
      enabled = false;
    }
    if (enabled) {
      const ids: string[] = [];
      for (const ref of fields.dispatch) {
        const t = resolve(ref);
        if (!t) {
          logger?.warn({ botId, ref }, 'Planner tasks: dispatch names no open task');
          continue;
        }
        if (ids.includes(t.id)) continue;
        if (input.hardGateActive && classifyAction(t.text) === 'CONTENT') {
          result.dispatched.push({ taskId: t.id, ok: false, reason: 'engagement-gate' });
          continue;
        }
        if (liveClaim(t, nowMs)) {
          result.dispatched.push({ taskId: t.id, ok: false, reason: 'claimed' });
          continue;
        }
        ids.push(t.id);
      }
      if (ids.length > 0) {
        let results: DispatchResult[] = [];
        try {
          results = pool.dispatch({ botId, taskIds: ids, cycleId });
        } catch (err) {
          logger?.warn({ botId, err }, 'Planner tasks: dispatch failed');
          for (const taskId of ids) result.dispatched.push({ taskId, ok: false, reason: 'error' });
        }
        for (const r of results) {
          if (r.ok) {
            dispatchedOk.add(r.taskId);
            result.dispatched.push({ taskId: r.taskId, runId: r.runId, ok: true });
          } else {
            result.dispatched.push({ taskId: r.taskId, ok: false, reason: r.reason });
          }
        }
        // keep the order the planner named them in
        result.dispatched.sort(
          (a, b) =>
            orderOf(fields.dispatch, a.taskId, resolve) -
            orderOf(fields.dispatch, b.taskId, resolve)
        );
      }
      logger?.info({ botId, cycleId, dispatched: result.dispatched }, 'Planner tasks: dispatched');
    }
  }

  // 3. serves_task
  if (fields.serves_task) {
    const t = resolve(fields.serves_task);
    if (t && !dispatchedOk.has(t.id)) {
      result.servesTask = { id: t.id, text: t.text, goalId: t.goalId };
    }
  }
  return result;
}

function orderOf(
  refs: string[] | undefined,
  taskId: string,
  resolve: (ref: string) => StoredTask | null
): number {
  const i = (refs ?? []).findIndex((ref) => ref === taskId || resolve(ref)?.id === taskId);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

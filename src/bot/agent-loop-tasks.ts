/**
 * The planner's task fields (goal tasks plan, phase 1, C8): the prompt blocks
 * that ask for them, their parsing, and the loop step that acts on them.
 *
 * D2: the planner chooses; the loop and the worker pool act. The loop writes
 * `new_tasks` and dispatches only what the planner named explicitly. Idle
 * cycles write nothing; explore and engagement-gated cycles write tasks and
 * standing marks but never dispatch; a content task is never dispatched while
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
    '- BREAK A GOAL DOWN: when the goal you serve this cycle has an end state and no open task, you MUST add "new_tasks": {"goal": "<goal id or exact title>", "tasks": [2–5 concrete, verifiable steps]} in this answer. One line each; each names a result someone could check (a file written, a message sent, a decision recorded). Only that one goal, and only when it has no open task. For a research goal, the tasks are its open questions, in the order you will answer them.',
    '- STANDING GOALS: a goal with no end state (a habit or a recurring duty, e.g. "read 2 sources per cycle", "every day research X") gets no tasks. The first time you serve one that is not marked standing yet, add "standing_goal": "<goal id>" and do one round of it in your plan. Goals already marked standing goal: just do a round.',
    '- "serves_task": the id of the open task your own plan works on, when it works on one.',
  ];
  if (opts.workersEnabled) {
    lines.push(
      '- "dispatch": ["t-…"] — open tasks to hand to workers, who work them in the background while you do something else. Prefer handing a multi-step task to a worker; do a single-step task yourself. Only tasks no worker holds (see Workers). A task you add in new_tasks this cycle may be named by its exact text. Do not dispatch the task your own plan serves.'
    );
  }
  return lines.join('\n');
}

/** The JSON Schema lines for the task fields. */
export function buildTaskSchemaLines(opts: { workersEnabled: boolean }): string {
  const lines = [
    '- new_tasks: {"goal": string, "tasks": array of 2-5 strings} (optional — only for a goal with no open task)',
    '- serves_task: string, the id of the open task your plan works on (optional)',
    '- standing_goal: string, the id of a goal with no end state you are marking standing (optional)',
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
  const standing = cleanLine(parsed.standing_goal);
  if (standing) out.standing_goal = standing;
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
  /** The loop picked it (`pickAutoDispatch`), not the planner. */
  auto?: true;
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
  /**
   * When the planner dispatched nothing, hand one open task of another goal to
   * a worker (`pickAutoDispatch`). Off by default; the loop passes
   * `workers.autoDispatch`.
   */
  autoDispatch?: boolean;
  /** Mark a goal standing (writes `- kind: standing` as the agent). Returns whether it was written. */
  markStanding?: (goal: GoalEntry) => boolean;
  logger?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  nowMs?: number;
}

export interface ApplyPlannerTasksResult {
  /** Ids of the tasks `new_tasks` wrote (or matched as near-duplicates). */
  newTaskIds: string[];
  dispatched: CycleDispatch[];
  /** The open task the cycle's own work serves. */
  servesTask?: { id: string; text: string; goalId: string };
  /** The goal the planner marked standing this cycle. */
  standingGoalId?: string;
  /** Idle: nothing was done. Explore / gated: only the books (new_tasks, standing_goal) were kept. */
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
  // An idle answer writes nothing. Explore and gated cycles still keep the
  // books (a breakdown, a standing mark) but hand nothing to workers and
  // serve no task: their own work is not the goal's.
  if (input.idle) {
    if (fields.new_tasks || fields.dispatch || fields.standing_goal) {
      logger?.info(
        { botId, cycleId, skipped: 'idle' },
        'Planner tasks: not acted on in this cycle'
      );
    }
    result.skipped = 'idle';
    return result;
  }
  const bookkeepingOnly = input.gateBlocked ? 'gated' : input.exploring ? 'explore' : undefined;
  if (bookkeepingOnly) {
    result.skipped = bookkeepingOnly;
    if (fields.dispatch || fields.serves_task) {
      logger?.info(
        { botId, cycleId, skipped: bookkeepingOnly },
        'Planner tasks: dispatch and serves_task not acted on in this cycle'
      );
    }
  }
  // 0. standing_goal: a goal with no end state gets no tasks.
  if (fields.standing_goal && input.markStanding) {
    const g = resolveGoalRef(fields.standing_goal, input.goals);
    if (!g) {
      logger?.warn(
        { botId, goal: fields.standing_goal },
        'Planner tasks: standing_goal names no active goal'
      );
    } else if (g.kind !== 'standing') {
      try {
        if (input.markStanding(g)) {
          result.standingGoalId = g.id;
          logger?.info({ botId, goalId: g.id }, 'Planner tasks: goal marked standing');
        }
      } catch (err) {
        logger?.warn({ botId, err }, 'Planner tasks: marking a goal standing failed');
      }
    }
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
  if (fields.dispatch && pool && !bookkeepingOnly) {
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

  // 2b. auto-dispatch: the planner was offered workers in every cycle and
  // dispatched nothing, so the loop hands one task over itself.
  if (input.autoDispatch && pool && !bookkeepingOnly && !result.dispatched.some((d) => d.ok)) {
    try {
      if (pool.isEnabledFor(botId) && !pool.list(botId).some((r) => isActiveRun(r.status))) {
        const served = fields.serves_task ? resolve(fields.serves_task) : null;
        const pick = pickAutoDispatch({
          tasks: list(),
          goals: input.goals,
          servedTaskId: served?.id,
          servedGoalId: served?.goalId,
          hardGateActive: input.hardGateActive,
          nowMs,
        });
        if (pick) {
          const [r] = pool.dispatch({ botId, taskIds: [pick.id], cycleId });
          if (r?.ok) {
            dispatchedOk.add(r.taskId);
            result.dispatched.push({ taskId: r.taskId, runId: r.runId, ok: true, auto: true });
          } else if (r) {
            result.dispatched.push({ taskId: r.taskId, ok: false, reason: r.reason, auto: true });
          }
          logger?.info(
            { botId, cycleId, taskId: pick.id, ok: r?.ok },
            'Planner tasks: auto-dispatched'
          );
        }
      }
    } catch (err) {
      logger?.warn({ botId, err }, 'Planner tasks: auto-dispatch failed');
    }
  }

  // 3. serves_task
  if (fields.serves_task && !bookkeepingOnly) {
    const t = resolve(fields.serves_task);
    if (t && !dispatchedOk.has(t.id)) {
      result.servesTask = { id: t.id, text: t.text, goalId: t.goalId };
    }
  }
  return result;
}

/** A task a worker cannot move on its own: it waits on the operator's answer or approval. */
const WAITS_ON_OPERATOR =
  /\b(operator|operador|human|ask_human|approv|aprob|decision|decisión|veredicto|verdict|feedback)/i;

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * The open task the loop hands to a worker when the planner dispatched none:
 * to do, unclaimed, not the task the cycle serves, of an active goal that is
 * neither blocked nor standing, not waiting on the operator, and not content
 * while the hard engagement gate is on. A goal other than the served one
 * first, then goal priority, goal order and task order. Null when none fits.
 */
export function pickAutoDispatch(input: {
  tasks: StoredTask[];
  goals: GoalEntry[];
  servedTaskId?: string;
  servedGoalId?: string;
  hardGateActive: boolean;
  nowMs: number;
}): StoredTask | null {
  const goalAt = new Map<string, { index: number; goal: GoalEntry }>();
  input.goals.forEach((goal, index) => {
    if (goal.id) goalAt.set(goal.id, { index, goal });
  });
  const candidates = input.tasks.filter((t) => {
    const g = goalAt.get(t.goalId)?.goal;
    if (!g || g.status === 'blocked' || g.kind === 'standing') return false;
    if (t.lane !== 'todo' || t.id === input.servedTaskId) return false;
    if (liveClaim(t, input.nowMs)) return false;
    if (WAITS_ON_OPERATOR.test(t.text)) return false;
    if (input.hardGateActive && classifyAction(t.text) === 'CONTENT') return false;
    return true;
  });
  const key = (t: StoredTask): number[] => {
    const at = goalAt.get(t.goalId) as { index: number; goal: GoalEntry };
    return [
      t.goalId === input.servedGoalId ? 1 : 0,
      PRIORITY_RANK[at.goal.priority ?? 'medium'] ?? 1,
      at.index,
      t.order,
    ];
  };
  candidates.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
  return candidates[0] ?? null;
}

function orderOf(
  refs: string[] | undefined,
  taskId: string,
  resolve: (ref: string) => StoredTask | null
): number {
  const i = (refs ?? []).findIndex((ref) => ref === taskId || resolve(ref)?.id === taskId);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

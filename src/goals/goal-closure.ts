/**
 * A goal that closes (completed or removed — by the strategist, the curiosity
 * navigator or the operator) takes its workers with it: every active run on one
 * of its tasks is stopped (`goal-closed`) and every claim still held on its
 * tasks is released. Plan: docs/plans/goal-tasks-architecture-plan.md, C21.
 *
 * Lanes are kept: the goal is closed, so its tasks are history, not a queue.
 * Never throws — closing a goal must never fail because of its tasks.
 */

import { type WorkerPoolApi, isActiveRun } from '../workers/types';
import type { StoredTask, TaskOp, TaskStore } from './task-store';

export interface CloseGoalTasksArgs {
  botId: string;
  goalIds: string[];
  store: Pick<TaskStore, 'list' | 'apply'> | null | undefined;
  pool?: Pick<WorkerPoolApi, 'list' | 'stop'> | null;
  cycleId?: string;
  onError?: (err: unknown) => void;
}

export interface CloseGoalTasksResult {
  /** Run ids the pool agreed to stop. */
  stopped: string[];
  /** Task ids whose claim was released. */
  released: string[];
}

export function closeGoalTasks(args: CloseGoalTasksArgs): CloseGoalTasksResult {
  const out: CloseGoalTasksResult = { stopped: [], released: [] };
  const goals = new Set(args.goalIds.filter(Boolean));
  if (goals.size === 0) return out;

  let tasks: StoredTask[] = [];
  try {
    tasks = args.store ? args.store.list().filter((t) => goals.has(t.goalId)) : [];
  } catch (err) {
    args.onError?.(err);
    return out;
  }
  const taskIds = new Set(tasks.map((t) => t.id));

  if (args.pool) {
    try {
      for (const run of args.pool.list(args.botId)) {
        if (!isActiveRun(run.status)) continue;
        if (!taskIds.has(run.taskId) && !(run.goalId && goals.has(run.goalId))) continue;
        if (args.pool.stop(run.runId, 'goal-closed')) out.stopped.push(run.runId);
      }
    } catch (err) {
      args.onError?.(err);
    }
  }

  // Stopping a run releases its claim asynchronously (or not at all when the
  // run is already gone): release what is still held, with the holder's token.
  if (args.store) {
    for (const t of tasks) {
      if (!t.claim) continue;
      const op: TaskOp = { op: 'release', id: t.id, token: t.claim.token, lane: t.lane };
      try {
        const r = args.store.apply([op], {
          actor: 'system',
          runId: t.claim.runId,
          ...(args.cycleId ? { cycleId: args.cycleId } : {}),
        });
        if (r.ok) out.released.push(t.id);
      } catch (err) {
        args.onError?.(err);
      }
    }
  }
  return out;
}

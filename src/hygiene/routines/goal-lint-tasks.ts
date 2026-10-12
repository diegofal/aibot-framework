/**
 * goal-lint task checks (C22, report-only): tasks of the task store
 * (`<soulDir>/TASKS.json`) that need a look.
 *
 * - `task-stalled`: In progress, no live run (claim or active worker run) and
 *   no task event for ≥ `STALLED_CYCLES` cycles of the bot (cycle log;
 *   skipped cycles do not count).
 * - `task-blocked-no-ask`: Blocked for > `BLOCKED_HOURS` with no pending ask
 *   (a worker run waiting on an ask, or a live claim).
 * - `task-done-no-note`: done without the note D8 asks for.
 * - `orphan-task`: its goal id is not in GOALS.md (neither active nor completed).
 *
 * Reads only: TASKS.json (no migration), goal-events.jsonl, the cycle log.
 */

import { join } from 'node:path';
import { type GoalEvent, readGoalEvents } from '../../bot/goal-events';
import {
  type StoredTask,
  TASKS_FILE,
  goalIdsOf,
  liveClaim,
  readTasksSnapshot,
} from '../../goals/task-store';
import { readAgentCycles } from '../../stats/readers/agent-cycles';
import { parseGoals } from '../../tools/goals';
import { isActiveRun } from '../../workers/types';
import type { HygieneContext, HygieneFinding } from '../types';

export const STALLED_CYCLES = 3;
export const BLOCKED_HOURS = 72;
/** How far back the cycle log is read for a stalled task. */
const CYCLE_LOOKBACK_MS = 30 * 86_400_000;
const H = 3_600_000;

const toMs = (ts: string | undefined): number | null => {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
};

export function taskFindings(ctx: HygieneContext, goalsMd: string): HygieneFinding[] {
  if (!ctx.soulDir || !ctx.botId) return [];
  const botId = ctx.botId;
  let tasks: StoredTask[];
  try {
    tasks = readTasksSnapshot(ctx.soulDir).tasks;
  } catch {
    return [];
  }
  if (tasks.length === 0) return [];

  const nowMs = ctx.now.getTime();
  const goalIds = goalIdsOf(goalsMd);
  const activeIds = new Set(
    parseGoals(goalsMd)
      .active.map((g) => g.id)
      .filter(Boolean)
  );

  let runs: ReturnType<NonNullable<HygieneContext['deps']['workerRuns']>> = [];
  try {
    runs = ctx.deps.workerRuns?.(botId) ?? [];
  } catch {
    runs = [];
  }
  const runningTasks = new Set(runs.filter((r) => isActiveRun(r.status)).map((r) => r.taskId));
  const askingTasks = new Set(
    runs.filter((r) => r.status === 'waiting' && r.wait?.kind === 'ask').map((r) => r.taskId)
  );

  const byTask = new Map<string, GoalEvent[]>();
  for (const ev of readGoalEvents(ctx.soulDir)) {
    if (!ev.taskId) continue;
    const list = byTask.get(ev.taskId) ?? [];
    list.push(ev);
    byTask.set(ev.taskId, list);
  }
  const lastEventMs = (t: StoredTask) =>
    Math.max(
      ...[t.startedAt, t.createdAt, ...(byTask.get(t.id) ?? []).map((e) => e.ts)].map(
        (ts) => toMs(ts) ?? 0
      )
    );

  let cycleStarts: number[] | null = null;
  const cyclesSince = (sinceMs: number): number => {
    if (cycleStarts === null) {
      cycleStarts = readAgentCycles(
        join(ctx.dataDir, 'agent-cycles'),
        botId,
        nowMs - CYCLE_LOOKBACK_MS,
        nowMs
      )
        .filter((c) => c.status !== 'skipped')
        .map((c) => toMs(c.startedAt) ?? 0);
    }
    return cycleStarts.filter((t) => t > sinceMs && t <= nowMs).length;
  };

  const findings: HygieneFinding[] = [];
  const push = (t: StoredTask, kind: string, severity: 'info' | 'warn', message: string) =>
    findings.push({
      id: `goal-lint:${kind}:${t.id}`,
      kind,
      severity,
      file: TASKS_FILE,
      line: null,
      message,
      fixable: false,
      data: { taskId: t.id, goalId: t.goalId, text: t.text, lane: t.lane },
    });

  for (const t of tasks) {
    if (!goalIds.has(t.goalId)) {
      push(
        t,
        'orphan-task',
        'info',
        `Task "${t.text}" belongs to goal ${t.goalId}, which is not in GOALS.md`
      );
      continue;
    }
    const worked = runningTasks.has(t.id) || !!liveClaim(t, nowMs);

    if (t.lane === 'in_progress' && activeIds.has(t.goalId) && !worked) {
      const n = cyclesSince(lastEventMs(t));
      if (n >= STALLED_CYCLES)
        push(
          t,
          'task-stalled',
          'warn',
          `Task "${t.text}" is In progress with no run and no change for ${n} cycles`
        );
    }

    if (t.lane === 'blocked' && !worked && !askingTasks.has(t.id)) {
      const blockedAt = (byTask.get(t.id) ?? [])
        .filter((e) => e.to === 'blocked')
        .map((e) => toMs(e.ts) ?? 0)
        .reduce((a, b) => Math.max(a, b), 0);
      const hours = blockedAt > 0 ? Math.floor((nowMs - blockedAt) / H) : 0;
      if (hours > BLOCKED_HOURS)
        push(
          t,
          'task-blocked-no-ask',
          'warn',
          `Task "${t.text}" has been Blocked for ${hours} h and nobody was asked`
        );
    }

    if (t.lane === 'done' && !t.note?.trim())
      push(t, 'task-done-no-note', 'info', `Task "${t.text}" is done without a note`);
  }
  return findings;
}

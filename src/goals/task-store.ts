/**
 * Task store — the tasks of a bot's goals, one JSON file per soul dir.
 *
 * `<soulDir>/TASKS.json` = `{ version: 1, rev, tasks }`. One synchronous
 * writer, `apply(ops, opts)`: every op checks out or nothing is written; a
 * write bumps `rev`, backs the previous file up (optional), writes atomically
 * (tmp + rename) and appends one `task-*` row per op to `goal-events.jsonl`.
 *
 * Claims (`claim` / `renew` / `release`) are compare-and-swap leases for a
 * worker run: while one is live only its holder (`claimToken`) or the
 * operator may move or edit the task. An operator move or remove releases the
 * claim and reports it (`releasedClaim`) so the caller can stop the worker.
 *
 * Tasks used to be `- task: [ ] …` lines in GOALS.md. The first load of a
 * soul dir lifts them into the store and rewrites GOALS.md without them
 * (idempotent; lines that reappear from a restored file are lifted again
 * without duplicates). `readTasksSnapshot` reads both without writing, for
 * the read-only stats readers.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type GoalActor,
  type GoalEvent,
  appendGoalEvents,
  writeGoalsFile,
} from '../bot/goal-events';
import { textSimilarity } from '../hygiene/text-utils';
import { type GoalEntry, newTaskId, parseGoals, startGoal, taskStatus } from '../tools/goals';
import { emitTaskChanged } from './task-events-bus';

export const TASKS_FILE = 'TASKS.json';
export const TASK_LANES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type TaskLane = (typeof TASK_LANES)[number];
/** Open (not done) tasks one goal may hold. */
export const TASK_OPEN_CAP = 12;
/** Characters in a task's text or note. */
export const TASK_TEXT_MAX = 200;
/** Cycle ids remembered per task. */
export const TASK_CYCLES_KEEP = 10;
/** An added task this similar to an open one of its goal is that task. */
export const TASK_DEDUPE_SIMILARITY = 0.8;

/** Who applies ops: the operator (dashboard), the agent (manage_goals) or the system (loop, workers, migration). */
export type TaskActor = 'operator' | 'agent' | 'system';

export interface TaskClaim {
  runId: string;
  token: string;
  /** ISO time the lease ends unless renewed. */
  expiresAt: string;
}

export interface StoredTask {
  /** `t-` + 6 hex. */
  id: string;
  goalId: string;
  text: string;
  lane: TaskLane;
  /** Position within its goal (ascending). */
  order: number;
  by: 'operator' | 'agent';
  createdAt: string;
  createdCycle?: string;
  /** Who last moved it into in_progress: the agent loop (a claim), the agent or the operator. */
  startedBy?: 'loop' | 'agent' | 'operator';
  startedAt?: string;
  startedCycle?: string;
  note?: string;
  doneAt?: string;
  claim?: TaskClaim;
  /** Cycles that touched the task, oldest first, at most `TASK_CYCLES_KEEP`. */
  cycles: string[];
}

export interface TasksFile {
  version: 1;
  rev: number;
  tasks: StoredTask[];
}

export type TaskOp =
  | { op: 'add'; goalId: string; text: string; lane?: TaskLane }
  | { op: 'move'; id: string; lane: TaskLane; note?: string }
  | { op: 'edit'; id: string; text: string }
  | { op: 'note'; id: string; text: string }
  | { op: 'remove'; id: string }
  | { op: 'reorder'; goalId: string; ids: string[] }
  | { op: 'claim'; id: string; runId: string; ttlMs: number }
  | { op: 'renew'; id: string; token: string; ttlMs: number }
  | { op: 'release'; id: string; token: string; lane: TaskLane; note?: string };

export interface ApplyOptions {
  actor: TaskActor;
  cycleId?: string;
  runId?: string;
  /** Refuse with `conflict` unless the store is still at this revision. */
  expectedRev?: number;
  /** The claim token of the worker applying the ops. */
  claimToken?: string;
}

export interface TaskOpResult {
  op: TaskOp['op'];
  /** The task id (the goal id for `reorder`). */
  id: string;
  /** `add` matched an open task of the goal: nothing was added. */
  existing?: true;
  /** `claim`: the token the holder must present. */
  token?: string;
  /** An operator move/remove ended a live claim: stop that run. */
  releasedClaim?: { runId: string };
}

export type TaskFailure = 'conflict' | 'claimed' | 'not-found' | 'invalid' | 'cap';

export type ApplyResult =
  | { ok: true; rev: number; results: TaskOpResult[] }
  | { ok: false; reason: TaskFailure; message: string; rev: number };

export interface TaskStoreOptions {
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Called with a file path before it is overwritten (TASKS.json and GOALS.md). */
  backup?: (path: string) => void;
  /** Event-log and parse warnings; never thrown. */
  onError?: (err: unknown) => void;
  /** The bot this soul dir belongs to, stamped on `task:changed` notices when known. */
  botId?: string;
}

const LEGACY_TASK_LINE = /^\s*- task:/m;
const EMPTY = (): TasksFile => ({ version: 1, rev: 0, tasks: [] });

class OpError extends Error {
  constructor(
    readonly reason: TaskFailure,
    message: string
  ) {
    super(message);
  }
}

/** A task's claim, when it is still live at `nowMs`. */
export function liveClaim(task: StoredTask, nowMs: number): TaskClaim | undefined {
  const c = task.claim;
  if (!c) return undefined;
  const until = Date.parse(c.expiresAt);
  return Number.isFinite(until) && until > nowMs ? c : undefined;
}

/** One line, collapsed whitespace; throws `invalid` when empty (unless allowed) or too long. */
function cleanText(raw: unknown, what: string, allowEmpty = false): string {
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text && !allowEmpty) throw new OpError('invalid', `${what} cannot be empty`);
  if (text.length > TASK_TEXT_MAX)
    throw new OpError('invalid', `${what} is longer than ${TASK_TEXT_MAX} characters`);
  return text;
}

function checkLane(lane: unknown): TaskLane {
  if (!(TASK_LANES as readonly unknown[]).includes(lane))
    throw new OpError('invalid', `lane must be one of ${TASK_LANES.join(', ')}`);
  return lane as TaskLane;
}

const byOrder = (a: StoredTask, b: StoredTask) => a.order - b.order;

function readTasksJson(path: string, onError?: (err: unknown) => void): TasksFile {
  if (!existsSync(path)) return EMPTY();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<TasksFile>;
    return {
      version: 1,
      rev: typeof raw.rev === 'number' ? raw.rev : 0,
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    };
  } catch (err) {
    onError?.(err);
    return EMPTY();
  }
}

/** Legacy `- task:` lines of parsed goals as stored tasks (ids missing ones get fresh). */
function liftLegacy(goals: GoalEntry[], nowIso: string, startOrder: (goalId: string) => number) {
  const out: StoredTask[] = [];
  for (const g of goals) {
    if (!g.id || !g.tasks?.length) continue;
    const base = startOrder(g.id);
    g.tasks.forEach((t, i) => {
      const lane = taskStatus(t);
      const task: StoredTask = {
        id: t.id ?? newTaskId(),
        goalId: g.id as string,
        text: t.text,
        lane,
        order: base + i,
        // Tasks written before authors were recorded all came from the dashboard.
        by: t.by ?? 'operator',
        createdAt: nowIso,
        cycles: t.cycleId ? [t.cycleId] : [],
      };
      if (t.cycleId) task.createdCycle = t.cycleId;
      out.push(task);
    });
  }
  return out;
}

/**
 * The tasks of a soul dir without writing anything: TASKS.json plus any
 * legacy `- task:` lines still in GOALS.md (not yet migrated).
 */
export function readTasksSnapshot(soulDir: string): { rev: number; tasks: StoredTask[] } {
  const file = readTasksJson(join(soulDir, TASKS_FILE));
  const goalsPath = join(soulDir, 'GOALS.md');
  if (!existsSync(goalsPath)) return { rev: file.rev, tasks: file.tasks };
  let content: string;
  try {
    content = readFileSync(goalsPath, 'utf-8');
  } catch {
    return { rev: file.rev, tasks: file.tasks };
  }
  if (!LEGACY_TASK_LINE.test(content)) return { rev: file.rev, tasks: file.tasks };
  const { active, completed } = parseGoals(content);
  const known = new Set(file.tasks.map((t) => t.id));
  const lifted = liftLegacy([...active, ...completed], new Date().toISOString(), () => 0).filter(
    (t) => !known.has(t.id)
  );
  return { rev: file.rev, tasks: [...file.tasks, ...lifted] };
}

/** Goal ids present in a GOALS.md (active and completed). */
export function goalIdsOf(goalsMd: string | null): Set<string> {
  const { active, completed } = parseGoals(goalsMd);
  return new Set([...active, ...completed].map((g) => g.id).filter((id): id is string => !!id));
}

/** Tasks whose goal still exists, in goal order then task order. */
export function filterOrphans(tasks: StoredTask[], goalsMd: string | null): StoredTask[] {
  const ids = goalIdsOf(goalsMd);
  return tasks.filter((t) => ids.has(t.goalId)).sort(byOrder);
}

const START_BY: Record<TaskActor, StoredTask['startedBy']> = {
  operator: 'operator',
  agent: 'agent',
  system: 'loop',
};
/** Who a task row names. */
const EVENT_ACTOR: Record<TaskActor, GoalActor> = {
  operator: 'operator',
  agent: 'agent',
  system: 'system',
};
/** Who a goal nudged by a task reads as: the loop's claims are the agent working. */
const GOAL_ACTOR: Record<TaskActor, GoalActor> = {
  operator: 'operator',
  agent: 'agent',
  system: 'agent',
};

export class TaskStore {
  readonly path: string;
  private readonly goalsPath: string;
  private readonly now: () => Date;

  constructor(
    readonly soulDir: string,
    private readonly opts: TaskStoreOptions = {}
  ) {
    this.path = join(soulDir, TASKS_FILE);
    this.goalsPath = join(soulDir, 'GOALS.md');
    this.now = opts.now ?? (() => new Date());
  }

  /** The whole file (migrating legacy GOALS.md task lines first). */
  read(): TasksFile {
    this.migrate();
    return readTasksJson(this.path, this.opts.onError);
  }

  /** Every stored task, orphans included. */
  list(): StoredTask[] {
    return this.read().tasks;
  }

  /** Tasks whose goal still exists in GOALS.md (active or completed). */
  listForGoals(goalsMd?: string | null): StoredTask[] {
    const tasks = this.list();
    return filterOrphans(tasks, goalsMd === undefined ? this.readGoalsMd() : goalsMd);
  }

  /** One goal's tasks in order. */
  forGoal(goalId: string): StoredTask[] {
    return this.list()
      .filter((t) => t.goalId === goalId)
      .sort(byOrder);
  }

  get(id: string): StoredTask | undefined {
    return this.list().find((t) => t.id === id);
  }

  /** Apply ops all-or-nothing. */
  apply(ops: TaskOp[], opts: ApplyOptions): ApplyResult {
    const file = this.read();
    if (opts.expectedRev !== undefined && opts.expectedRev !== file.rev) {
      return {
        ok: false,
        reason: 'conflict',
        message: `The tasks changed (rev ${file.rev}, you had ${opts.expectedRev}). Reload and try again.`,
        rev: file.rev,
      };
    }
    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const nowMs = nowDate.getTime();
    const goalsMd = this.readGoalsMd();
    const { active, completed } = parseGoals(goalsMd);
    const titleOf = new Map<string, string>();
    for (const g of [...active, ...completed]) if (g.id) titleOf.set(g.id, g.text);
    const activeIds = new Set(active.map((g) => g.id).filter(Boolean));

    const tasks: StoredTask[] = structuredClone(file.tasks);
    const results: TaskOpResult[] = [];
    const rows: GoalEvent[] = [];
    const toStart = new Set<string>();
    let changed = false;

    const row = (
      op: GoalEvent['op'],
      t: Pick<StoredTask, 'id' | 'goalId' | 'text'>,
      extra: Partial<GoalEvent> = {}
    ) => {
      const ev: GoalEvent = {
        ts: nowIso,
        goalId: t.goalId,
        title: titleOf.get(t.goalId) ?? '',
        op,
        taskId: t.id,
        task: t.text,
        actor: EVENT_ACTOR[opts.actor],
        ...extra,
      };
      if (opts.cycleId) ev.cycleId = opts.cycleId;
      if (opts.runId) ev.runId = opts.runId;
      rows.push(ev);
    };
    const find = (id: string) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new OpError('not-found', `No task ${id}`);
      return t;
    };
    const touch = (t: StoredTask) => {
      if (!opts.cycleId) return;
      t.cycles = [...(t.cycles ?? []).filter((c) => c !== opts.cycleId), opts.cycleId].slice(
        -TASK_CYCLES_KEEP
      );
    };
    const openCount = (goalId: string) =>
      tasks.filter((t) => t.goalId === goalId && t.lane !== 'done').length;
    const guardClaim = (t: StoredTask) => {
      const claim = liveClaim(t, nowMs);
      if (!claim || opts.actor === 'operator' || opts.claimToken === claim.token) return;
      throw new OpError('claimed', `Task ${t.id} is being worked on by run ${claim.runId}`);
    };
    /** An operator move/remove ends a live claim; returns what to report. */
    const releaseForOperator = (t: StoredTask) => {
      const claim = liveClaim(t, nowMs);
      if (!claim || opts.actor !== 'operator' || opts.claimToken === claim.token) {
        if (t.claim && !claim) t.claim = undefined;
        return undefined;
      }
      t.claim = undefined;
      row('task-release', t, { from: t.lane, to: t.lane, runId: claim.runId });
      return { runId: claim.runId };
    };
    const setLane = (t: StoredTask, lane: TaskLane) => {
      if (lane !== 'done' && t.lane === 'done' && openCount(t.goalId) >= TASK_OPEN_CAP)
        throw new OpError('cap', `This goal already has ${TASK_OPEN_CAP} open tasks`);
      if (lane === 'in_progress' && t.lane !== 'in_progress') {
        t.startedAt = nowIso;
        if (opts.cycleId) t.startedCycle = opts.cycleId;
        else t.startedCycle = undefined;
      }
      if (lane === 'done' && t.lane !== 'done') t.doneAt = nowIso;
      if (lane !== 'done') t.doneAt = undefined;
      t.lane = lane;
      if (lane === 'in_progress' || lane === 'done') toStart.add(t.goalId);
    };

    try {
      for (const op of ops) {
        switch (op.op) {
          case 'add': {
            if (!activeIds.has(op.goalId))
              throw new OpError('not-found', `No active goal ${op.goalId}`);
            const text = cleanText(op.text, 'A task');
            const lane = op.lane === undefined ? 'todo' : checkLane(op.lane);
            const dupe = tasks.find(
              (t) =>
                t.goalId === op.goalId &&
                t.lane !== 'done' &&
                textSimilarity(t.text, text) >= TASK_DEDUPE_SIMILARITY
            );
            if (dupe) {
              results.push({ op: 'add', id: dupe.id, existing: true });
              break;
            }
            if (lane !== 'done' && openCount(op.goalId) >= TASK_OPEN_CAP)
              throw new OpError('cap', `This goal already has ${TASK_OPEN_CAP} open tasks`);
            const siblings = tasks.filter((t) => t.goalId === op.goalId);
            const task: StoredTask = {
              id: newTaskId(),
              goalId: op.goalId,
              text,
              lane: 'todo',
              order: siblings.length ? Math.max(...siblings.map((t) => t.order)) + 1 : 0,
              by: opts.actor === 'operator' ? 'operator' : 'agent',
              createdAt: nowIso,
              cycles: [],
            };
            if (opts.cycleId) task.createdCycle = opts.cycleId;
            if (lane !== 'todo') {
              setLane(task, lane);
              if (lane === 'in_progress') task.startedBy = START_BY[opts.actor];
            }
            touch(task);
            tasks.push(task);
            row('task-add', task, { to: task.lane });
            results.push({ op: 'add', id: task.id });
            changed = true;
            break;
          }
          case 'move': {
            const t = find(op.id);
            const lane = checkLane(op.lane);
            const note = op.note === undefined ? undefined : cleanText(op.note, 'A note', true);
            guardClaim(t);
            const released = releaseForOperator(t);
            const from = t.lane;
            if (lane === 'in_progress' && from !== 'in_progress')
              t.startedBy = START_BY[opts.actor];
            setLane(t, lane);
            if (note !== undefined) t.note = note || undefined;
            touch(t);
            row('task-move', t, { from, to: lane, ...(note ? { note } : {}) });
            results.push({
              op: 'move',
              id: t.id,
              ...(released ? { releasedClaim: released } : {}),
            });
            changed = true;
            break;
          }
          case 'edit': {
            const t = find(op.id);
            const text = cleanText(op.text, 'A task');
            guardClaim(t);
            const from = t.text;
            t.text = text;
            touch(t);
            row('task-edit', t, { from, to: text });
            results.push({ op: 'edit', id: t.id });
            changed = true;
            break;
          }
          case 'note': {
            const t = find(op.id);
            const note = cleanText(op.text, 'A note', true);
            guardClaim(t);
            t.note = note || undefined;
            touch(t);
            row('task-note', t, note ? { note } : {});
            results.push({ op: 'note', id: t.id });
            changed = true;
            break;
          }
          case 'remove': {
            const t = find(op.id);
            guardClaim(t);
            const released = releaseForOperator(t);
            tasks.splice(tasks.indexOf(t), 1);
            row('task-remove', t, { from: t.lane });
            results.push({
              op: 'remove',
              id: t.id,
              ...(released ? { releasedClaim: released } : {}),
            });
            changed = true;
            break;
          }
          case 'reorder': {
            const mine = tasks.filter((t) => t.goalId === op.goalId).sort(byOrder);
            const ids = Array.isArray(op.ids) ? op.ids : [];
            for (const id of ids)
              if (!mine.some((t) => t.id === id))
                throw new OpError('not-found', `No task ${id} in goal ${op.goalId}`);
            const listed = ids.map((id) => mine.find((t) => t.id === id) as StoredTask);
            const rest = mine.filter((t) => !ids.includes(t.id));
            [...new Set([...listed, ...rest])].forEach((t, i) => {
              t.order = i;
            });
            rows.push({
              ts: nowIso,
              goalId: op.goalId,
              title: titleOf.get(op.goalId) ?? '',
              op: 'task-reorder',
              actor: EVENT_ACTOR[opts.actor],
              ...(opts.cycleId ? { cycleId: opts.cycleId } : {}),
              ...(opts.runId ? { runId: opts.runId } : {}),
            });
            results.push({ op: 'reorder', id: op.goalId });
            changed = true;
            break;
          }
          case 'claim': {
            const t = find(op.id);
            const live = liveClaim(t, nowMs);
            if (live)
              throw new OpError('claimed', `Task ${t.id} is already claimed by run ${live.runId}`);
            const token = randomUUID();
            const from = t.lane;
            if (from !== 'in_progress') t.startedBy = 'loop';
            setLane(t, 'in_progress');
            t.startedBy = 'loop';
            t.claim = {
              runId: op.runId,
              token,
              expiresAt: new Date(nowMs + Math.max(0, op.ttlMs)).toISOString(),
            };
            touch(t);
            row('task-claim', t, { from, to: 'in_progress', runId: op.runId });
            results.push({ op: 'claim', id: t.id, token });
            changed = true;
            break;
          }
          case 'renew': {
            const t = find(op.id);
            if (!t.claim || t.claim.token !== op.token)
              throw new OpError('claimed', `Task ${t.id} is not claimed with that token`);
            t.claim = {
              ...t.claim,
              expiresAt: new Date(nowMs + Math.max(0, op.ttlMs)).toISOString(),
            };
            results.push({ op: 'renew', id: t.id });
            changed = true;
            break;
          }
          case 'release': {
            const t = find(op.id);
            const lane = checkLane(op.lane);
            const note = op.note === undefined ? undefined : cleanText(op.note, 'A note', true);
            if (!t.claim || t.claim.token !== op.token)
              throw new OpError('claimed', `Task ${t.id} is not claimed with that token`);
            const runId = t.claim.runId;
            t.claim = undefined;
            const from = t.lane;
            setLane(t, lane);
            if (note !== undefined) t.note = note || undefined;
            touch(t);
            row('task-release', t, { from, to: lane, runId, ...(note ? { note } : {}) });
            results.push({ op: 'release', id: t.id });
            changed = true;
            break;
          }
          default:
            throw new OpError('invalid', `Unknown op ${(op as { op?: string }).op}`);
        }
      }
    } catch (err) {
      if (err instanceof OpError)
        return { ok: false, reason: err.reason, message: err.message, rev: file.rev };
      throw err;
    }

    if (!changed) return { ok: true, rev: file.rev, results };
    const next: TasksFile = { version: 1, rev: file.rev + 1, tasks };
    this.writeFile(next);
    appendGoalEvents(this.soulDir, rows, this.opts.onError);
    for (const goalId of toStart) this.startGoal(goalId, opts);
    this.publishChanges(rows, next.rev);
    return { ok: true, rev: next.rev, results };
  }

  /** One `task:changed` notice per written row (renews write no row: heartbeats stay quiet). */
  private publishChanges(rows: GoalEvent[], rev: number): void {
    for (const r of rows) {
      emitTaskChanged({
        soulDir: this.soulDir,
        ...(this.opts.botId ? { botId: this.opts.botId } : {}),
        data: {
          taskId: r.taskId ?? '',
          goalId: r.goalId,
          op: r.op,
          ...(r.from !== undefined ? { from: r.from } : {}),
          ...(r.to !== undefined ? { to: r.to } : {}),
          ...(r.runId ? { runId: r.runId } : {}),
          rev,
        },
      });
    }
  }

  /** A To do goal whose task started (or finished) moves to in_progress. */
  private startGoal(goalId: string, opts: ApplyOptions): void {
    const current = this.readGoalsMd();
    const next = startGoal(current, goalId);
    if (next === null) return;
    try {
      writeGoalsFile(this.goalsPath, next, {
        actor: GOAL_ACTOR[opts.actor],
        cycleId: opts.cycleId,
        reason: 'A task of this goal started',
        backup: this.opts.backup,
        onError: this.opts.onError,
      });
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private readGoalsMd(): string | null {
    try {
      return existsSync(this.goalsPath) ? readFileSync(this.goalsPath, 'utf-8') : null;
    } catch {
      return null;
    }
  }

  private writeFile(file: TasksFile): void {
    if (!existsSync(this.soulDir)) mkdirSync(this.soulDir, { recursive: true });
    if (existsSync(this.path)) this.opts.backup?.(this.path);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
    renameSync(tmp, this.path);
  }

  /** Lift legacy `- task:` lines out of GOALS.md (idempotent). */
  private migrate(): void {
    let content = this.readGoalsMd();
    if (!content || !LEGACY_TASK_LINE.test(content)) return;
    const write = (next: Parameters<typeof writeGoalsFile>[1], reason?: string) =>
      writeGoalsFile(this.goalsPath, next, {
        actor: 'system',
        reason,
        backup: this.opts.backup,
        onError: this.opts.onError,
        now: this.now,
      });
    let { active, completed } = parseGoals(content);
    if ([...active, ...completed].some((g) => g.tasks?.length && !g.id)) {
      // Ids first, as their own write: a rewrite with fresh ids would read as remove + add.
      content = write(content);
      ({ active, completed } = parseGoals(content));
    }
    const file = readTasksJson(this.path, this.opts.onError);
    const known = new Set(file.tasks.map((t) => t.id));
    const nextOrder = (goalId: string) => {
      const mine = file.tasks.filter((t) => t.goalId === goalId);
      return mine.length ? Math.max(...mine.map((t) => t.order)) + 1 : 0;
    };
    // A line without an id gets a fresh one each time: match those by goal and text.
    const sameText = new Set(file.tasks.map((t) => `${t.goalId}|${t.text.trim().toLowerCase()}`));
    const lifted = liftLegacy(
      [...active, ...completed],
      this.now().toISOString(),
      nextOrder
    ).filter(
      (t) => !known.has(t.id) && !sameText.has(`${t.goalId}|${t.text.trim().toLowerCase()}`)
    );
    if (lifted.length > 0) {
      this.writeFile({ version: 1, rev: file.rev + 1, tasks: [...file.tasks, ...lifted] });
    }
    for (const g of [...active, ...completed]) g.tasks = undefined;
    write({ active, completed }, 'Tasks moved to TASKS.json');
  }
}

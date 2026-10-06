/**
 * Goal events — one append-only log of every change to a bot's GOALS.md.
 *
 * Every GOALS.md writer goes through `writeGoalsFile`: it carries ids over
 * from the previous file (by title, for writers that rebuilt goals without
 * them), assigns missing ids, stamps `updated` on changed goals and `started`
 * the first time a goal goes in_progress, diffs old vs new by id, appends one
 * row per change to `<soulDir>/goal-events.jsonl`, backs up and writes.
 * The log lives in the soul dir so it travels with a bot export.
 * Logging never blocks the write.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type GoalEntry,
  ensureGoalIds,
  newGoalId,
  parseGoals,
  serializeGoals,
} from '../tools/goals';

export { newGoalId };

export const GOAL_EVENTS_FILE = 'goal-events.jsonl';

export type GoalEventOp =
  | 'add'
  | 'title'
  | 'status'
  | 'notes'
  | 'priority'
  | 'complete'
  | 'reopen'
  | 'remove';

export type GoalActor =
  | 'agent'
  | 'strategist'
  | 'curiosity'
  | 'operator'
  | 'reflection'
  | 'lint'
  | 'wizard'
  | 'unknown';

export interface GoalEvent {
  ts: string;
  goalId: string;
  title: string;
  op: GoalEventOp;
  from?: string;
  to?: string;
  actor: GoalActor;
  cycleId?: string;
}

/** A change without its envelope (ts, actor, cycleId). */
export type GoalChange = Pick<GoalEvent, 'goalId' | 'title' | 'op' | 'from' | 'to'>;

export interface GoalsState {
  active: GoalEntry[];
  completed: GoalEntry[];
}

export interface GoalWriteOptions {
  actor: GoalActor;
  cycleId?: string;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Called with the GOALS.md path before it is overwritten (soul-file versioning). */
  backup?: (path: string) => void;
  /** Warnings from the event log; never thrown. */
  onError?: (err: unknown) => void;
}

const keyOf = (g: GoalEntry) => g.id ?? `title:${g.text.trim().toLowerCase()}`;
const norm = (v: string | undefined) => (v ?? '').trim();

function change(g: GoalEntry, op: GoalEventOp, from?: string, to?: string): GoalChange {
  return {
    goalId: g.id ?? '',
    title: g.text,
    op,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

/**
 * What changed between two goal sets, matched by id (title when an id is missing).
 * A completed goal that simply disappears is the 10-item cap, not a removal.
 */
export function diffGoals(prev: GoalsState, next: GoalsState): GoalChange[] {
  const before = new Map<string, { goal: GoalEntry; done: boolean }>();
  for (const g of prev.active) before.set(keyOf(g), { goal: g, done: false });
  for (const g of prev.completed) before.set(keyOf(g), { goal: g, done: true });

  const out: GoalChange[] = [];
  const seen = new Set<string>();
  const visit = (g: GoalEntry, done: boolean) => {
    const key = keyOf(g);
    seen.add(key);
    const old = before.get(key);
    if (!old) {
      out.push(
        done ? change(g, 'complete', undefined, 'completed') : change(g, 'add', undefined, g.status)
      );
      return;
    }
    if (norm(old.goal.text) !== norm(g.text)) out.push(change(g, 'title', old.goal.text, g.text));
    if (!old.done && done) out.push(change(g, 'complete', old.goal.status, 'completed'));
    else if (old.done && !done) out.push(change(g, 'reopen', 'completed', g.status));
    else if (!done && norm(old.goal.status) !== norm(g.status))
      out.push(change(g, 'status', old.goal.status, g.status));
    if (norm(old.goal.notes) !== norm(g.notes))
      out.push(change(g, 'notes', old.goal.notes, g.notes));
    if (!done && norm(old.goal.priority) !== norm(g.priority))
      out.push(change(g, 'priority', old.goal.priority, g.priority));
  };
  for (const g of next.active) visit(g, false);
  for (const g of next.completed) visit(g, true);

  for (const [key, { goal, done }] of before) {
    if (!seen.has(key) && !done) out.push(change(goal, 'remove', goal.status));
  }
  return out;
}

/** Give goals the previous file's id/started/created when a writer rebuilt them without. */
function carryOver(prev: GoalsState, next: GoalsState): void {
  const byTitle = new Map<string, GoalEntry>();
  for (const g of [...prev.active, ...prev.completed]) {
    byTitle.set(g.text.trim().toLowerCase(), g);
  }
  const byId = new Map<string, GoalEntry>();
  for (const g of [...prev.active, ...prev.completed]) if (g.id) byId.set(g.id, g);
  const taken = new Set<string>();
  for (const g of [...next.active, ...next.completed]) if (g.id) taken.add(g.id);
  for (const g of [...next.active, ...next.completed]) {
    const old = (g.id && byId.get(g.id)) || byTitle.get(g.text.trim().toLowerCase());
    if (!old) continue;
    // Two goals with the same title: only the first inherits the id.
    if (!g.id && old.id && !taken.has(old.id)) {
      g.id = old.id;
      taken.add(old.id);
    }
    if (g.id !== old.id) continue;
    if (!g.started && old.started) g.started = old.started;
    if (!g.created && old.created) g.created = old.created;
    if (!g.source && old.source) g.source = old.source;
    if (!g.updated && old.updated) g.updated = old.updated;
  }
}

/** Read a bot's goal events (oldest first); malformed lines are skipped. */
export function readGoalEvents(soulDir: string): GoalEvent[] {
  const path = join(soulDir, GOAL_EVENTS_FILE);
  if (!existsSync(path)) return [];
  const out: GoalEvent[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as GoalEvent);
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * The single GOALS.md writer. `next` is the new file (markdown or parsed goals).
 * Returns the content actually written.
 */
export function writeGoalsFile(
  goalsPath: string,
  next: string | GoalsState,
  opts: GoalWriteOptions
): string {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const prevContent = existsSync(goalsPath) ? readFileSync(goalsPath, 'utf-8') : null;
  const prev = parseGoals(prevContent);
  const state: GoalsState =
    typeof next === 'string'
      ? parseGoals(next)
      : {
          active: next.active.map((g) => ({ ...g })),
          completed: next.completed.map((g) => ({ ...g })),
        };

  // Free-form text with no goals in it: write it as given rather than lose it.
  if (typeof next === 'string' && state.active.length + state.completed.length === 0) {
    if (next === prevContent) return next;
    opts.backup?.(goalsPath);
    writeFileSync(goalsPath, next, 'utf-8');
    return next;
  }

  // Legacy goals without ids get one first, so carryOver hands it to their rewrite.
  ensureGoalIds(prev.active, prev.completed);
  carryOver(prev, state);
  ensureGoalIds(state.active, state.completed);

  const changes = diffGoals(prev, state);
  const touched = new Set(changes.map((c) => c.goalId));
  for (const g of [...state.active, ...state.completed]) {
    if (!g.id || !touched.has(g.id)) continue;
    g.updated = now;
    if (!g.started && g.status === 'in_progress') g.started = now;
  }

  const content = serializeGoals(state.active, state.completed);
  if (content === prevContent) return content;

  opts.backup?.(goalsPath);
  writeFileSync(goalsPath, content, 'utf-8');

  try {
    const rows = changes.map((c) => {
      const ev: GoalEvent = { ts: now, ...c, actor: opts.actor };
      if (opts.cycleId) ev.cycleId = opts.cycleId;
      return JSON.stringify(ev);
    });
    if (rows.length > 0) {
      appendFileSync(join(dirname(goalsPath), GOAL_EVENTS_FILE), `${rows.join('\n')}\n`, 'utf-8');
    }
  } catch (err) {
    opts.onError?.(err);
  }
  return content;
}

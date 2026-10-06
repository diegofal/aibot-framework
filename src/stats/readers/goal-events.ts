/**
 * Per-goal history in the soul dir: `goal-events.jsonl` (one line per change
 * to a goal, written by the agent loop / dashboard) and the GOALS.md metadata
 * lines `parseGoals` does not keep (`id`, `started`, `updated`).
 * Read-only; never throws, never creates anything.
 */
import { join } from 'node:path';
import { readJsonlSafe, readTextSafe } from '../util';

export interface GoalEvent {
  ts: string;
  goalId?: string;
  title?: string;
  op: string;
  from?: string | null;
  to?: string | null;
  actor?: string;
  cycleId?: string;
}

export interface GoalExtras {
  id?: string;
  started?: string;
  updated?: string;
}

/** Key goals by their title, the way `parseGoals` sees it. */
export function goalTitleKey(text: string): string {
  return text.trim().toLowerCase();
}

export function readGoalEvents(soulDir: string): GoalEvent[] {
  return readJsonlSafe<GoalEvent>(join(soulDir, 'goal-events.jsonl')).filter(
    (e) => e && typeof e.ts === 'string' && typeof e.op === 'string'
  );
}

const GOAL_LINE = /^- \[[ xX]\] (.+)$/;
const META_LINE = /^- (id|started|updated):\s*(.+)$/;

/** `id` / `started` / `updated` per goal title (lowercased, trimmed). */
export function readGoalExtras(soulDir: string): Map<string, GoalExtras> {
  const out = new Map<string, GoalExtras>();
  const text = readTextSafe(join(soulDir, 'GOALS.md'));
  if (!text) return out;
  let current: GoalExtras | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    const goal = GOAL_LINE.exec(trimmed);
    if (goal) {
      current = {};
      out.set(goalTitleKey(goal[1]), current);
      continue;
    }
    if (trimmed.startsWith('#')) {
      current = null;
      continue;
    }
    const meta = META_LINE.exec(trimmed);
    if (meta && current) current[meta[1] as keyof GoalExtras] = meta[2].trim();
  }
  return out;
}

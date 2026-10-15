import { goalTurnIntervalMs } from '../stats/goal-activity';
/**
 * Standing goals get a turn. A standing goal (`- kind: standing`) never gets
 * tasks, so nothing pulled the planner toward it: the big project goals took
 * every cycle and the standing ones read "stalled" on the board. Here: which
 * standing goals are due a round (no completed cycle served them within one
 * turn), most overdue first, and the planner block that names them. Pure; the
 * agent loop reads the cycle log and passes it in.
 */
import type { AgentCycleRecord } from '../stats/readers/agent-cycles';
import type { GoalEntry } from '../tools/goals';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A standing goal is never due more often than once a day. */
export const STANDING_TURN_FLOOR_MS = DAY_MS;
/** How far back the loop reads the cycle log for rounds. */
export const STANDING_LOOKBACK_MS = 14 * DAY_MS;
/** Idle and skipped cycles did no work: not a round. */
const NO_WORK = new Set(['idle', 'skipped']);

export interface StandingGoalDue {
  goalId: string;
  title: string;
  /** Start of the newest completed cycle that served it; null = never (in the lookback). */
  lastRoundAt: string | null;
}

/**
 * How long a standing goal may wait for a round: the board's turn interval
 * (loop interval × active non-blocked goals, stretched by cycles that served
 * no goal), never under 24 h.
 */
export function standingTurnIntervalMs(input: {
  loopMs: number;
  goals: GoalEntry[];
  cycles: AgentCycleRecord[];
  nowMs: number;
}): number {
  const goalCount = input.goals.filter((g) => g.status !== 'blocked').length;
  const turn = goalTurnIntervalMs({
    loopMs: input.loopMs,
    goalCount,
    cycles: input.cycles,
    nowMs: input.nowMs,
  });
  return Math.max(STANDING_TURN_FLOOR_MS, turn);
}

/**
 * The active standing goals with no completed cycle within `turnMs`, never
 * served first, then the oldest round first (goal order breaks ties).
 */
export function dueStandingGoals(input: {
  goals: GoalEntry[];
  cycles: AgentCycleRecord[];
  nowMs: number;
  turnMs: number;
}): StandingGoalDue[] {
  const last = new Map<string, number>();
  for (const c of input.cycles) {
    if (!c.goalId || NO_WORK.has(c.status ?? '')) continue;
    const t = Date.parse(c.startedAt ?? '');
    if (!Number.isFinite(t) || t > input.nowMs) continue;
    if (t > (last.get(c.goalId) ?? Number.NEGATIVE_INFINITY)) last.set(c.goalId, t);
  }
  const due: Array<StandingGoalDue & { at: number; index: number }> = [];
  input.goals.forEach((g, index) => {
    if (g.kind !== 'standing' || !g.id) return;
    const at = last.get(g.id);
    if (at !== undefined && input.nowMs - at < input.turnMs) return;
    due.push({
      goalId: g.id,
      title: g.text,
      lastRoundAt: at === undefined ? null : new Date(at).toISOString(),
      at: at ?? Number.NEGATIVE_INFINITY,
      index,
    });
  });
  due.sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at));
  return due.map(({ goalId, title, lastRoundAt }) => ({ goalId, title, lastRoundAt }));
}

function ago(iso: string | null, nowMs: number): string {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return 'never';
  const ms = Math.max(0, nowMs - t);
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)}h ago`;
  return `${Math.floor(ms / DAY_MS)}d ago`;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** "## Standing goals due", or '' when none is due. */
export function buildStandingDueSection(due: StandingGoalDue[], nowMs = Date.now()): string {
  if (due.length === 0) return '';
  const lines = [
    '## Standing goals due',
    '',
    'Standing goals have no tasks, so they only move when a cycle gives them a round. These are overdue (most overdue first):',
    ...due.map(
      (d) => `- [${d.goalId}] ${oneLine(d.title, 120)} — last round ${ago(d.lastRoundAt, nowMs)}`
    ),
    '',
    'Do one round of the first one this cycle and name it in serves_goal, unless a goal set by your operator or a task a worker is waiting on needs you more.',
  ];
  return lines.join('\n');
}

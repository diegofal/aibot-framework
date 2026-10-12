/**
 * Agent cycle log — one row per agent-loop cycle, the spine of per-goal
 * attribution. Every LLM call, tool call, production, outcome, ask and karma
 * event of a cycle carries the same `cycleId`; this row says which goal the
 * cycle served and how that was decided.
 *
 * Path: `<paths.data>/agent-cycles/<botId>/YYYY-MM-DD.jsonl` (UTC date of
 * `startedAt`, the same convention as the tool audit). Appends never throw.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredTask } from '../goals/task-store';
import type { Logger } from '../logger';
import { type GoalEntry, goalFromManageGoalsArgs, resolveGoalRef } from '../tools/goals';

export type CycleGoalSource = 'planner' | 'strategist' | 'manage_goals';

/** Who or what the `reason` of an idle/skipped/error cycle comes from. */
export type CycleReasonSource =
  | 'planner'
  | 'engagement-gate'
  | 'circuit-breaker'
  | 'error'
  | 'system';

export interface AgentCycleEntry {
  cycleId: string;
  botId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** `completed` | `idle` | `skipped` | `error` */
  status: string;
  focus: string | null;
  planSummary: string | null;
  plan: string[] | null;
  priority: string | null;
  toolCalls: number;
  tools: string[];
  goalId: string | null;
  goalTitle: string | null;
  goalSource: CycleGoalSource | null;
  /**
   * Why an idle/skipped/error cycle went that way, as recorded when it did:
   * the planner's reasoning, the engagement-gate verdict, the `skippedReason`
   * (`circuit-open:<backend>`) or the error. Absent on completed cycles and on
   * rows written before it was recorded.
   */
  reason?: string;
  reasonSource?: CycleReasonSource;
  /** Whether the strategist ran in this cycle (absent on older rows). */
  strategistRan?: boolean;
  /** The strategist's reflection, capped at `CYCLE_TEXT_MAX` chars. */
  reflection?: string;
  /** Trait deltas the strategist applied this cycle (after clamping and policy). */
  traitAdjustments?: Record<string, number>;
  /** The open task the cycle's own work served (planner `serves_task`). */
  taskId?: string;
  /** That task's text when the cycle ran. */
  taskText?: string;
  /** Ids of the tasks the planner's `new_tasks` wrote this cycle. */
  newTasks?: string[];
  /** What the planner's `dispatch` became: a worker run, or why not. */
  dispatched?: Array<{ taskId: string; runId?: string; ok: boolean; reason?: string }>;
}

/** Cap for `reason` and `reflection` on a cycle row. */
export const CYCLE_TEXT_MAX = 600;

const capText = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > CYCLE_TEXT_MAX ? `${t.slice(0, CYCLE_TEXT_MAX - 1)}…` : t;
};

/** The parts of a cycle result `explainCycle` reads. */
export interface CycleResultLike {
  summary: string;
  plannerReasoning: string;
  strategistRan: boolean;
  strategistReflection?: string;
  skippedReason?: string;
  /** Set when the engagement gate held a content plan back. */
  idleRule?: string;
}

/**
 * The why-fields of a cycle row, from what the cycle itself produced (never
 * re-asked): idle → engagement-gate verdict, else the planner's reasoning;
 * skipped → `skippedReason` (circuit breaker) or the summary; error → the
 * error summary. Plus whether the strategist ran and its reflection.
 */
export function explainCycle(
  status: string,
  result: CycleResultLike | undefined
): Pick<AgentCycleEntry, 'reason' | 'reasonSource' | 'strategistRan' | 'reflection'> {
  const out: Pick<AgentCycleEntry, 'reason' | 'reasonSource' | 'strategistRan' | 'reflection'> = {
    strategistRan: result?.strategistRan === true,
  };
  if (!result) return out;
  const set = (text: string | undefined, source: CycleReasonSource) => {
    const t = text ? capText(text) : '';
    if (t) {
      out.reason = t;
      out.reasonSource = source;
    }
  };
  if (status === 'idle') {
    if (result.idleRule) set(result.idleRule, 'engagement-gate');
    else set(result.plannerReasoning || result.summary, 'planner');
  } else if (status === 'skipped') {
    if (result.skippedReason?.startsWith('circuit-open:'))
      set(result.skippedReason, 'circuit-breaker');
    else set(result.skippedReason || result.summary, 'system');
  } else if (status === 'error') {
    set(result.summary, 'error');
  }
  const reflection = result.strategistReflection ? capText(result.strategistReflection) : '';
  if (out.strategistRan && reflection) out.reflection = reflection;
  return out;
}

export interface CycleGoal {
  goalId: string | null;
  goalTitle: string | null;
  goalSource: CycleGoalSource | null;
}

const NO_GOAL: CycleGoal = { goalId: null, goalTitle: null, goalSource: null };

/**
 * The goal a cycle served: the planner's `serves_goal`, else the strategist's,
 * else the goal an in-cycle `manage_goals` call named. Record only — a missing
 * or unknown goal leaves the cycle unattributed.
 */
export function resolveCycleGoal(
  refs: {
    planner?: string;
    strategist?: string;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    /** Store tasks, so `update_task` / `note_task` calls resolve through their task's goal. */
    tasks?: StoredTask[];
  },
  goals: GoalEntry[]
): CycleGoal {
  const hit = (g: GoalEntry | null, goalSource: CycleGoalSource): CycleGoal | null =>
    g?.id ? { goalId: g.id, goalTitle: g.text, goalSource } : null;
  return (
    hit(resolveGoalRef(refs.planner, goals), 'planner') ??
    hit(resolveGoalRef(refs.strategist, goals), 'strategist') ??
    (refs.toolCalls ?? [])
      .filter((c) => c.name === 'manage_goals')
      .map((c) => hit(goalFromManageGoalsArgs(c.args, goals, refs.tasks), 'manage_goals'))
      .find((g) => g !== null) ??
    NO_GOAL
  );
}

export class AgentCycleLog {
  constructor(
    private dataDir: string,
    private logger?: Pick<Logger, 'warn'>
  ) {}

  append(entry: AgentCycleEntry): void {
    try {
      const dir = join(this.dataDir, entry.botId);
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, `${entry.startedAt.slice(0, 10)}.jsonl`),
        `${JSON.stringify(entry)}\n`,
        'utf-8'
      );
    } catch (err) {
      this.logger?.warn({ err, botId: entry.botId }, 'AgentCycleLog: failed to append entry');
    }
  }

  /** All rows for a bot on a UTC date (oldest first); malformed lines skipped. */
  getEntries(botId: string, date: string): AgentCycleEntry[] {
    const path = join(this.dataDir, botId, `${date}.jsonl`);
    if (!existsSync(path)) return [];
    const out: AgentCycleEntry[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AgentCycleEntry);
      } catch {
        // skip
      }
    }
    return out;
  }

  /** Dates with a log for the bot, newest first. */
  getAvailableDates(botId: string): string[] {
    const dir = join(this.dataDir, botId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
      .sort()
      .reverse();
  }
}

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
import type { Logger } from '../logger';
import { type GoalEntry, goalFromManageGoalsArgs, resolveGoalRef } from '../tools/goals';

export type CycleGoalSource = 'planner' | 'strategist' | 'manage_goals';

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
      .map((c) => hit(goalFromManageGoalsArgs(c.args, goals), 'manage_goals'))
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

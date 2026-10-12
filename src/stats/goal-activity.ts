/**
 * How recently the agent worked on each goal, from the cycle log: the Fleet
 * Board card's "worked 8h ago · 4 cycles / 7d" line and its 7-day bars. A cycle
 * counts for the goal it recorded (`goalId`); idle and skipped cycles did no
 * work and do not count. Pure; the caller reads the log.
 */
import type { BotConfig, Config } from '../config';
import type { AgentCycleRecord } from './readers/agent-cycles';
import { toMs } from './util';

/** Bars on the card: one per day, the last one ending now. */
export const GOAL_ACTIVITY_DAYS = 7;
/** How far back "last worked" looks; older goals read as never worked. */
export const GOAL_ACTIVITY_LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;
const NO_WORK = new Set(['idle', 'skipped']);

export interface GoalActivity {
  /** Start of the newest cycle that served the goal. */
  lastCycleAt: string;
  /** Cycles in the last 7 days. */
  cycles7d: number;
  /** Cycles per day over the last 7 days, oldest first (24 h windows ending now). */
  daily: number[];
}

export function buildGoalActivity(
  cycles: AgentCycleRecord[],
  nowMs: number
): Record<string, GoalActivity> {
  const out: Record<string, GoalActivity> = {};
  const last: Record<string, number> = {};
  for (const c of cycles) {
    if (!c.goalId || NO_WORK.has(c.status ?? '')) continue;
    const t = toMs(c.startedAt);
    if (t === null) continue;
    const a = (out[c.goalId] ??= {
      lastCycleAt: c.startedAt,
      cycles7d: 0,
      daily: new Array(GOAL_ACTIVITY_DAYS).fill(0),
    });
    if (t > (last[c.goalId] ?? Number.NEGATIVE_INFINITY)) {
      last[c.goalId] = t;
      a.lastCycleAt = new Date(t).toISOString();
    }
    const daysAgo = Math.floor((nowMs - t) / DAY_MS);
    if (daysAgo >= 0 && daysAgo < GOAL_ACTIVITY_DAYS) {
      a.cycles7d++;
      a.daily[GOAL_ACTIVITY_DAYS - 1 - daysAgo]++;
    }
  }
  return out;
}

/** The bot's agent-loop interval (`agentLoop.every`, bot over global); 24 h when unset or unreadable. */
export function loopIntervalMs(bot: BotConfig, config: Config): number {
  const raw = bot.agentLoop?.every ?? config.agentLoop?.every ?? '';
  const m = /^(\d+)\s*(m|h|d)$/i.exec(String(raw).trim());
  if (!m) return DAY_MS;
  const n = Number.parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms = n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : DAY_MS);
  return ms > 0 ? ms : DAY_MS;
}

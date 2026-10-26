/**
 * Autonomy rung 0, C4: the guard metrics an applied change is watched by
 * (`ledger.ts` `checkGuards`). Read-only over records that already exist;
 * a reading is `undefined` whenever there is not enough data, and no data
 * never rolls a change back.
 *
 *   watcher.costUsdPerDay   mean USD-equivalent per day the watcher spent since
 *                           the change, from the budget files
 *                           (`<watcherDir>/budget-YYYY-MM-DD.json`). A day's
 *                           spend is assumed spread evenly over the part of the
 *                           day that has passed, so only the share after the
 *                           change counts; needs ≥ 6 h since the change and at
 *                           least one budget file in the range.
 *   fleet.errorCycleShare   share of agent-loop cycles that ended `error` since
 *                           the change, across the fleet's bots
 *                           (`<data>/agent-cycles/<botId>/`); needs ≥ 5 cycles.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readAgentCycles } from '../../stats/readers/agent-cycles';
import { budgetFile } from '../budget';
import type { ProposalGuard } from './types';

export const GUARD_METRICS = ['watcher.costUsdPerDay', 'fleet.errorCycleShare'] as const;
export type GuardMetric = (typeof GUARD_METRICS)[number];

export function isGuardMetric(m: unknown): m is GuardMetric {
  return typeof m === 'string' && (GUARD_METRICS as readonly string[]).includes(m);
}

/** A metric reading over `[sinceMs, nowMs]`; `undefined` = not enough data. */
export type GuardReader = (
  metric: string,
  range: { sinceMs: number; nowMs: number }
) => number | undefined | Promise<number | undefined>;

/** Below this much time since the change the cost reading is too noisy to act on. */
export const GUARD_MIN_ELAPSED_MS = 6 * 3_600_000;
/** Fewer cycles than this since the change is no reading. */
export const GUARD_MIN_CYCLES = 5;

const DAY_MS = 86_400_000;

/** True when `reading` regresses past the guard's bound. */
export function breaches(
  guard: Pick<ProposalGuard, 'direction' | 'bound'>,
  reading: number
): boolean {
  return guard.direction === 'max' ? reading > guard.bound : reading < guard.bound;
}

function dayCost(watcherDir: string, date: string): number | undefined {
  const path = budgetFile(watcherDir, date);
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    let sum = 0;
    for (const tier of ['notice', 'integrate']) {
      const c = (raw?.[tier] as { costUsd?: unknown } | undefined)?.costUsd;
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) sum += c;
    }
    return sum;
  } catch {
    return undefined;
  }
}

/** Mean USD-equivalent per day the watcher spent in `[sinceMs, nowMs]`. Never throws. */
export function readWatcherCostPerDay(
  watcherDir: string,
  sinceMs: number,
  nowMs: number
): number | undefined {
  const elapsed = nowMs - sinceMs;
  if (!Number.isFinite(elapsed) || elapsed < GUARD_MIN_ELAPSED_MS) return undefined;
  let total = 0;
  let files = 0;
  for (
    let dayStart = Math.floor(sinceMs / DAY_MS) * DAY_MS;
    dayStart <= nowMs;
    dayStart += DAY_MS
  ) {
    const passed = Math.min(DAY_MS, nowMs - dayStart);
    if (passed <= 0) continue;
    const cost = dayCost(watcherDir, new Date(dayStart).toISOString().slice(0, 10));
    if (cost === undefined) continue;
    files++;
    const covered = Math.min(dayStart + DAY_MS, nowMs) - Math.max(dayStart, sinceMs);
    total += cost * (covered / passed);
  }
  if (files === 0) return undefined;
  return total / (elapsed / DAY_MS);
}

/** Share of `error` cycles across `botIds` started in `[sinceMs, nowMs]`. Never throws. */
export function readFleetErrorShare(
  cyclesDir: string,
  botIds: readonly string[],
  sinceMs: number,
  nowMs: number
): number | undefined {
  let total = 0;
  let errors = 0;
  for (const botId of botIds) {
    let rows: ReturnType<typeof readAgentCycles>;
    try {
      rows = readAgentCycles(cyclesDir, botId, sinceMs, nowMs);
    } catch {
      continue;
    }
    for (const row of rows) {
      const t = Date.parse(row.startedAt);
      if (!(t >= sinceMs && t <= nowMs)) continue;
      total++;
      if (row.status === 'error') errors++;
    }
  }
  if (total < GUARD_MIN_CYCLES) return undefined;
  return errors / total;
}

export interface GuardReaderDeps {
  watcherDir: string;
  /** `<paths.data>/agent-cycles` (`resolveStatsDirs(config).agentCycles`). */
  cyclesDir: string;
  /** The bots the fleet share is over, read per call. */
  botIds: () => readonly string[];
}

/** The default reader: routes each known metric to its records; unknown → undefined. */
export function createGuardReader(deps: GuardReaderDeps): GuardReader {
  return (metric, { sinceMs, nowMs }) => {
    if (metric === 'watcher.costUsdPerDay') {
      return readWatcherCostPerDay(deps.watcherDir, sinceMs, nowMs);
    }
    if (metric === 'fleet.errorCycleShare') {
      return readFleetErrorShare(deps.cyclesDir, deps.botIds(), sinceMs, nowMs);
    }
    return undefined;
  };
}

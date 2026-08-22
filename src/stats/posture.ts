import type { Posture } from './types';

export interface PostureInput {
  enabled: boolean;
  nowMs: number;
  lastRunAt: number | null;
  retryCount: number;
  lastError: string | null;
  consecutiveIdleCycles: number;
  goalsActive: number;
  goalsByStatus: Record<string, number>;
  lastOutcomeAt: number | null;
}

const RETRY_BLOCKED_THRESHOLD = 3;
const IDLE_STANDBY_THRESHOLD = 5;
const RECENT_OUTCOME_MS = 48 * 3_600_000;
const STALE_RUN_MS = 3 * 86_400_000;

/**
 * Posture heuristic — a single word summarising what a bot is doing, in
 * priority order (first matching rule wins):
 *
 *  1. `dormant`  — `enabled: false` in config. Nothing else matters.
 *  2. `unknown`  — the agent loop has never run for this bot (no lastRunAt).
 *  3. `blocked`  — the loop is retrying with an error (retryCount >= 3 and a
 *                  lastError), OR every active goal carries status `blocked`.
 *  4. `idle`     — no active goals at all: the bot has nothing to pursue.
 *  5. `standby`  — has goals but is coasting: >= 5 consecutive idle cycles,
 *                  or the last run is older than 3 days, or there is no
 *                  production outcome in the last 48h and at least one idle
 *                  cycle in a row.
 *  6. `active`   — otherwise (goals, recent cycle, recent outcome or a
 *                  non-idle latest cycle).
 */
export function computePosture(input: PostureInput): Posture {
  if (!input.enabled) return 'dormant';
  if (input.lastRunAt === null) return 'unknown';

  if (input.retryCount >= RETRY_BLOCKED_THRESHOLD && input.lastError) return 'blocked';
  const blockedGoals = input.goalsByStatus.blocked ?? 0;
  if (input.goalsActive > 0 && blockedGoals >= input.goalsActive) return 'blocked';

  if (input.goalsActive === 0) return 'idle';

  if (input.consecutiveIdleCycles >= IDLE_STANDBY_THRESHOLD) return 'standby';
  if (input.nowMs - input.lastRunAt > STALE_RUN_MS) return 'standby';

  const recentOutcome =
    input.lastOutcomeAt !== null && input.nowMs - input.lastOutcomeAt <= RECENT_OUTCOME_MS;
  if (!recentOutcome && input.consecutiveIdleCycles > 0) return 'standby';

  return 'active';
}

import type { Posture, PostureInput, PostureVerdict } from './types';

export type { PostureInput, PostureRule, PostureVerdict } from './types';

export const RETRY_BLOCKED_THRESHOLD = 3;
export const IDLE_STANDBY_THRESHOLD = 5;
export const RECENT_OUTCOME_MS = 48 * 3_600_000;
export const STALE_RUN_MS = 3 * 86_400_000;

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
  return computePostureWithRule(input).posture;
}

/** The posture plus the rule that fired and the inputs it decided on. */
export function computePostureWithRule(input: PostureInput): PostureVerdict {
  const verdict = (posture: Posture, rule: PostureVerdict['rule']): PostureVerdict => ({
    posture,
    rule,
    inputs: { ...input, goalsByStatus: { ...input.goalsByStatus } },
  });
  if (!input.enabled) return verdict('dormant', 'disabled');
  if (input.lastRunAt === null) return verdict('unknown', 'never-ran');

  if (input.retryCount >= RETRY_BLOCKED_THRESHOLD && input.lastError) {
    return verdict('blocked', 'retries');
  }
  const blockedGoals = input.goalsByStatus.blocked ?? 0;
  if (input.goalsActive > 0 && blockedGoals >= input.goalsActive) {
    return verdict('blocked', 'all-goals-blocked');
  }

  if (input.goalsActive === 0) return verdict('idle', 'no-goals');

  if (input.consecutiveIdleCycles >= IDLE_STANDBY_THRESHOLD) {
    return verdict('standby', 'idle-streak');
  }
  if (input.nowMs - input.lastRunAt > STALE_RUN_MS) return verdict('standby', 'stale-run');

  const recentOutcome =
    input.lastOutcomeAt !== null && input.nowMs - input.lastOutcomeAt <= RECENT_OUTCOME_MS;
  if (!recentOutcome && input.consecutiveIdleCycles > 0) {
    return verdict('standby', 'no-recent-outcome');
  }

  return verdict('active', 'active');
}

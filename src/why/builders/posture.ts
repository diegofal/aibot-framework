/**
 * Why for an agent's posture (Agent Home header): the rule in
 * `computePostureWithRule` that fired, in plain words, and the numbers it
 * decided on. Deterministic; nothing is inferred.
 */
import {
  IDLE_STANDBY_THRESHOLD,
  RECENT_OUTCOME_MS,
  RETRY_BLOCKED_THRESHOLD,
  STALE_RUN_MS,
} from '../../stats/posture';
import type { PostureInput, PostureVerdict } from '../../stats/types';
import type { Why } from '../types';

const H = 3_600_000;
const DAY = 86_400_000;

/** "1 h ago", "3 days ago", "just now". */
function since(nowMs: number, at: number): string {
  const diff = Math.max(0, nowMs - at);
  if (diff < H) return 'just now';
  if (diff < 2 * DAY) return `${Math.round(diff / H)} h ago`;
  return `${Math.round(diff / DAY)} days ago`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function ruleText({ rule, inputs: i }: PostureVerdict): string {
  switch (rule) {
    case 'disabled':
      return 'Turned off in its config.';
    case 'never-ran':
      return 'Its agent loop has never run.';
    case 'retries':
      return `${i.retryCount} failed retries in a row. Last error: ${clip(
        String(i.lastError ?? '').replace(/\s+/g, ' '),
        160
      )}`;
    case 'all-goals-blocked':
      return `Every active goal is blocked (${i.goalsByStatus.blocked ?? 0} of ${i.goalsActive}).`;
    case 'no-goals':
      return 'No active goals to pursue.';
    case 'idle-streak':
      return `${i.consecutiveIdleCycles} idle cycles in a row (standby from ${IDLE_STANDBY_THRESHOLD}).`;
    case 'stale-run':
      return `Last run ${since(i.nowMs, i.lastRunAt ?? 0)} (standby after ${STALE_RUN_MS / DAY} days).`;
    case 'no-recent-outcome': {
      const idle =
        i.consecutiveIdleCycles === 1
          ? 'its last cycle was idle'
          : `its last ${i.consecutiveIdleCycles} cycles were idle`;
      return i.lastOutcomeAt === null
        ? `No output recorded yet, and ${idle}.`
        : `No output in the last ${RECENT_OUTCOME_MS / H} h (last one ${since(i.nowMs, i.lastOutcomeAt)}), and ${idle}.`;
    }
    case 'active': {
      const recent = i.lastOutcomeAt !== null && i.nowMs - i.lastOutcomeAt <= RECENT_OUTCOME_MS;
      return recent
        ? `Has active goals and produced output in the last ${RECENT_OUTCOME_MS / H} h.`
        : 'Has active goals and its latest cycle was not idle.';
    }
  }
}

function basedOn(i: PostureInput): string {
  const parts = [
    plural(i.goalsActive, 'active goal'),
    `${i.consecutiveIdleCycles} idle cycles in a row`,
    i.lastRunAt === null ? 'never ran' : `last run ${since(i.nowMs, i.lastRunAt)}`,
    i.lastOutcomeAt === null
      ? 'no output recorded'
      : `last output ${since(i.nowMs, i.lastOutcomeAt)}`,
  ];
  if (i.retryCount > 0) parts.push(`${i.retryCount} of ${RETRY_BLOCKED_THRESHOLD} retries`);
  return parts.join(' · ');
}

export function postureToWhy(v: PostureVerdict): Why {
  const why: Why = { what: `Posture: ${v.posture}`, by: 'system', rule: ruleText(v) };
  if (v.rule !== 'disabled') why.notes = [{ label: 'Based on', text: basedOn(v.inputs) }];
  return why;
}

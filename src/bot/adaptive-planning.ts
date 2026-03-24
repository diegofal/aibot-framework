/**
 * Adaptive Planning — Self-tuning agent loop parameters.
 *
 * Dynamically adjusts cycle interval, tool rounds, temperature, and
 * ask_human forcing based on measured outcomes (idle rate, plan success,
 * karma trend). Uses EMA smoothing and rate-limiting to prevent oscillation.
 */

import type { KarmaService } from '../karma/service';
import type { BotSchedule } from './agent-scheduler';

// ── Types ──

export interface AdaptiveParams {
  /** Multiplier on the configured cycle interval (1.0 = normal, 4.0 = 4x slower) */
  cycleIntervalMultiplier: number;
  /** Adjustment to max tool rounds per execution (+10 max, -5 min) */
  maxToolRoundsAdjust: number;
  /** Adjustment to executor/planner temperature (-0.3 min, +0.3 max) */
  temperatureAdjust: number;
  /** Force an ask_human on next cycle */
  forceAskHuman: boolean;
  /** Timestamp of last adaptive adjustment */
  lastAdaptiveAt: number | null;
}

export interface AdaptiveMetrics {
  /** Fraction of recent cycles that were idle (0.0-1.0) */
  idleRate: number;
  /** Fraction of plans that completed without error (0.0-1.0) */
  planSuccessRate: number;
  /** Karma trend: positive = improving, negative = declining */
  karmaTrend: number;
  /** Cycles since last ask_human */
  cyclesSinceAskHuman: number;
}

/** EMA smoothing factor — lower = smoother, less reactive */
const EMA_ALPHA = 0.3;
/** Minimum interval between adaptive adjustments (6 hours) */
const MIN_ADJUSTMENT_INTERVAL_MS = 6 * 3_600_000;

// ── Defaults ──

export function createDefaultAdaptiveParams(): AdaptiveParams {
  return {
    cycleIntervalMultiplier: 1.0,
    maxToolRoundsAdjust: 0,
    temperatureAdjust: 0,
    forceAskHuman: false,
    lastAdaptiveAt: null,
  };
}

// ── EMA ──

/** Exponential Moving Average: blends new sample into running value */
export function ema(current: number, newSample: number, alpha = EMA_ALPHA): number {
  return alpha * newSample + (1 - alpha) * current;
}

// ── Metrics computation ──

/**
 * Compute adaptive metrics from schedule state and karma.
 */
export function computeAdaptiveMetrics(
  schedule: BotSchedule,
  karmaService?: KarmaService | null,
  botId?: string
): AdaptiveMetrics {
  const actions = schedule.recentActions;
  const totalCycles = Math.max(actions.length + schedule.consecutiveIdleCycles, 1);
  const idleRate = schedule.consecutiveIdleCycles / totalCycles;

  // Plan success: non-idle actions count as "planned". We approximate
  // success as actions that exist (were executed) vs total cycles.
  const executedCount = actions.length;
  const planSuccessRate = executedCount / totalCycles;

  // Karma trend: compute slope from last 20 events
  let karmaTrend = 0;
  if (karmaService && botId) {
    try {
      const events = karmaService.getAllEvents(botId);
      const recent = events.slice(-20);
      if (recent.length >= 2) {
        const firstHalf = recent.slice(0, Math.floor(recent.length / 2));
        const secondHalf = recent.slice(Math.floor(recent.length / 2));
        const avgFirst = firstHalf.reduce((s, e) => s + e.delta, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((s, e) => s + e.delta, 0) / secondHalf.length;
        karmaTrend = avgSecond - avgFirst;
      }
    } catch {
      // karma not available
    }
  }

  return {
    idleRate,
    planSuccessRate,
    karmaTrend,
    cyclesSinceAskHuman: schedule.cyclesSinceAskHuman,
  };
}

// ── Core adaptive computation ──

/**
 * Compute adaptive adjustments based on current metrics and existing params.
 * Returns updated params (or same if rate-limited).
 */
export function computeAdaptiveAdjustments(
  current: AdaptiveParams,
  metrics: AdaptiveMetrics,
  askHumanCheckInThreshold = 5
): AdaptiveParams {
  const now = Date.now();

  // Rate-limit: max 1 adjustment per 6 hours
  if (
    current.lastAdaptiveAt !== null &&
    now - current.lastAdaptiveAt < MIN_ADJUSTMENT_INTERVAL_MS
  ) {
    return current;
  }

  let { cycleIntervalMultiplier, maxToolRoundsAdjust, temperatureAdjust } = current;
  let forceAskHuman = false;

  // Rule 1: High idle rate → slow down (stop wasting tokens)
  if (metrics.idleRate > 0.6) {
    cycleIntervalMultiplier = ema(cycleIntervalMultiplier, cycleIntervalMultiplier + 0.25);
  } else if (metrics.idleRate < 0.2) {
    // Active bot → gradually return to normal
    cycleIntervalMultiplier = ema(
      cycleIntervalMultiplier,
      Math.max(cycleIntervalMultiplier - 0.15, 1.0)
    );
  }

  // Rule 2: High success + positive karma → earn more autonomy
  if (metrics.planSuccessRate > 0.8 && metrics.karmaTrend > 0) {
    maxToolRoundsAdjust = ema(maxToolRoundsAdjust, maxToolRoundsAdjust + 2);
  }

  // Rule 3: Low success → become conservative
  if (metrics.planSuccessRate < 0.4) {
    maxToolRoundsAdjust = ema(maxToolRoundsAdjust, maxToolRoundsAdjust - 2);
    temperatureAdjust = ema(temperatureAdjust, temperatureAdjust - 0.1);
  }

  // Rule 4: Long silence + declining karma → force ask_human
  if (metrics.cyclesSinceAskHuman > askHumanCheckInThreshold * 2 && metrics.karmaTrend < 0) {
    forceAskHuman = true;
  }

  // Clamp values
  cycleIntervalMultiplier = clamp(cycleIntervalMultiplier, 0.5, 4.0);
  maxToolRoundsAdjust = clamp(Math.round(maxToolRoundsAdjust), -5, 10);
  temperatureAdjust = clamp(temperatureAdjust, -0.3, 0.3);

  return {
    cycleIntervalMultiplier,
    maxToolRoundsAdjust,
    temperatureAdjust,
    forceAskHuman,
    lastAdaptiveAt: now,
  };
}

// ── Helpers ──

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Render adaptive params for logging/dashboard display.
 */
export function renderAdaptiveParams(params: AdaptiveParams): string {
  const parts: string[] = [];
  if (params.cycleIntervalMultiplier !== 1.0) {
    parts.push(`interval: ${params.cycleIntervalMultiplier.toFixed(2)}x`);
  }
  if (params.maxToolRoundsAdjust !== 0) {
    parts.push(
      `toolRounds: ${params.maxToolRoundsAdjust > 0 ? '+' : ''}${params.maxToolRoundsAdjust}`
    );
  }
  if (params.temperatureAdjust !== 0) {
    parts.push(
      `temp: ${params.temperatureAdjust > 0 ? '+' : ''}${params.temperatureAdjust.toFixed(2)}`
    );
  }
  if (params.forceAskHuman) {
    parts.push('forceAskHuman');
  }
  return parts.length > 0 ? `Adaptive: ${parts.join(', ')}` : 'Adaptive: nominal';
}

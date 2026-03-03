/**
 * Provider Cooldown Tracker
 *
 * In-memory cooldown tracking for model/backend combinations.
 * When a candidate fails, we record a cooldown period so subsequent
 * requests skip it and go straight to the next candidate.
 *
 * Inspired by OpenClaw's auth-profiles/usage.ts cooldown logic,
 * stripped down to the essentials. No file persistence — cooldowns
 * reset on restart, which is actually desirable (restart = fresh state,
 * provider might be back up).
 *
 * OpenClaw's cooldown escalation: 1min → 5min → 25min → 60min max.
 * Billing errors get separate longer backoff: 5h → 24h max.
 * We adopt the same escalation curve.
 *
 * Target: src/bot/model-failover/cooldown-tracker.ts
 */

import type { FailoverReason } from './failover-error';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CooldownEntry {
  /** When the cooldown expires (Date.now() epoch ms) */
  until: number;
  /** What caused the cooldown */
  reason: FailoverReason;
  /** Consecutive failures (drives escalation) */
  consecutiveFailures: number;
  /** When the last failure happened */
  lastFailure: number;
}

export interface CooldownStatus {
  inCooldown: boolean;
  remainingMs: number;
  reason?: FailoverReason;
  consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cooldown escalation for non-billing errors.
 * Each consecutive failure increases the cooldown duration.
 * Index = min(consecutiveFailures - 1, len - 1)
 */
const STANDARD_COOLDOWN_MS = [
  60_000, // 1 min  (1st failure)
  300_000, // 5 min  (2nd failure)
  1_500_000, // 25 min (3rd failure)
  3_600_000, // 60 min (4th+ failures) — max
];

/**
 * Billing errors get much longer cooldowns.
 * Usually means the account is out of credits — no point hammering.
 */
const BILLING_COOLDOWN_MS = [
  18_000_000, // 5 hours (1st billing error)
  86_400_000, // 24 hours (2nd+ billing errors) — max
];

/**
 * After how long without failures we reset the consecutive counter.
 * If a provider is healthy for this long, we forget past failures.
 */
const FAILURE_MEMORY_MS = 30 * 60_000; // 30 minutes

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class ProviderCooldownTracker {
  private cooldowns = new Map<string, CooldownEntry>();

  /**
   * Build the map key for a candidate.
   * For backend-scoped errors (auth/billing), we track by backend only.
   * For model-scoped errors (rate_limit/timeout), we track by backend+model.
   */
  static makeKey(backend: string, model?: string, backendScoped = false): string {
    if (backendScoped || !model) return backend;
    return `${backend}/${model}`;
  }

  /**
   * Check if a candidate is currently in cooldown.
   */
  getCooldownStatus(key: string): CooldownStatus {
    const entry = this.cooldowns.get(key);
    if (!entry) {
      return { inCooldown: false, remainingMs: 0, consecutiveFailures: 0 };
    }

    const now = Date.now();
    if (now >= entry.until) {
      // Cooldown expired — but don't delete yet (we keep consecutiveFailures
      // for escalation until FAILURE_MEMORY_MS elapses)
      return {
        inCooldown: false,
        remainingMs: 0,
        reason: entry.reason,
        consecutiveFailures: entry.consecutiveFailures,
      };
    }

    return {
      inCooldown: true,
      remainingMs: entry.until - now,
      reason: entry.reason,
      consecutiveFailures: entry.consecutiveFailures,
    };
  }

  /**
   * Record a failure and set cooldown.
   */
  recordFailure(key: string, reason: FailoverReason): void {
    const now = Date.now();
    const existing = this.cooldowns.get(key);

    let consecutiveFailures = 1;
    if (existing) {
      // If last failure was recent enough, escalate. Otherwise reset.
      if (now - existing.lastFailure < FAILURE_MEMORY_MS) {
        consecutiveFailures = existing.consecutiveFailures + 1;
      }
    }

    const cooldownMs = this.computeCooldownMs(reason, consecutiveFailures);

    this.cooldowns.set(key, {
      until: now + cooldownMs,
      reason,
      consecutiveFailures,
      lastFailure: now,
    });
  }

  /**
   * Record a success — reset cooldown for this key.
   */
  recordSuccess(key: string): void {
    this.cooldowns.delete(key);
  }

  /**
   * Get a snapshot of all active cooldowns (for diagnostics/logging).
   */
  getActiveCooldowns(): Array<{ key: string; status: CooldownStatus }> {
    const result: Array<{ key: string; status: CooldownStatus }> = [];
    for (const [key] of this.cooldowns) {
      const status = this.getCooldownStatus(key);
      if (status.inCooldown) {
        result.push({ key, status });
      }
    }
    return result;
  }

  /**
   * Clear all cooldowns (useful for testing or manual reset).
   */
  clear(): void {
    this.cooldowns.clear();
  }

  /**
   * Prune expired entries that are past the failure memory window.
   * Call periodically to prevent unbounded map growth.
   */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cooldowns) {
      if (now >= entry.until && now - entry.lastFailure >= FAILURE_MEMORY_MS) {
        this.cooldowns.delete(key);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private computeCooldownMs(reason: FailoverReason, consecutiveFailures: number): number {
    const schedule = reason === 'billing' ? BILLING_COOLDOWN_MS : STANDARD_COOLDOWN_MS;
    const index = Math.min(consecutiveFailures - 1, schedule.length - 1);
    return schedule[index];
  }
}

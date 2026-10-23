/**
 * The watcher's daily LLM budget (phase 2). One file per UTC day,
 * `<dir>/budget-YYYY-MM-DD.json`, with calls, tokens and cost per tier, so a
 * restart never resets the count. `allow(tier)` is consulted before every
 * call: it refuses once the tier's daily cap (calls, and tokens for integrate)
 * is reached, and while the fleet circuit breaker is open for the tier's
 * backend (`isCircuitOpen`). Never throws on disk errors: an unreadable file
 * is an empty day, a failed write keeps the in-memory count.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type WatcherTier = 'notice' | 'integrate';

export interface BudgetLimits {
  notice: { maxPerDay: number };
  integrate: { maxPerDay: number; maxTokensPerDay: number };
}

export interface TierUsage {
  calls: number;
  tokens: number;
  costUsd: number;
}

export type BudgetDecision = { ok: true } | { ok: false; reason: 'cap' | 'tokens' | 'breaker' };

interface BudgetDay {
  date: string;
  notice: TierUsage;
  integrate: TierUsage;
  /** Tiers whose "capped" row was already logged today. */
  capLogged: WatcherTier[];
}

export interface DailyBudgetDeps {
  dir: string;
  limits: () => BudgetLimits;
  now?: () => number;
  /** True while the fleet breaker is open for the backend this tier calls. */
  isCircuitOpen?: (tier: WatcherTier) => boolean;
}

export function budgetFile(dir: string, date: string): string {
  return join(dir, `budget-${date}.json`);
}

const emptyUsage = (): TierUsage => ({ calls: 0, tokens: 0, costUsd: 0 });

function usageOf(raw: unknown): TierUsage {
  const r = (raw ?? {}) as Partial<TierUsage>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return { calls: n(r.calls), tokens: n(r.tokens), costUsd: n(r.costUsd) };
}

export class DailyBudget {
  private day: BudgetDay | null = null;
  private readonly now: () => number;
  /** Calls reserved and not recorded yet (process-local: a restart has none in flight). */
  private readonly inFlight: Record<WatcherTier, number> = { notice: 0, integrate: 0 };

  constructor(private readonly deps: DailyBudgetDeps) {
    this.now = deps.now ?? Date.now;
  }

  allow(tier: WatcherTier): BudgetDecision {
    if (this.deps.isCircuitOpen?.(tier)) return { ok: false, reason: 'breaker' };
    const used = this.current()[tier];
    const limits = this.deps.limits();
    if (used.calls + this.inFlight[tier] >= limits[tier].maxPerDay) {
      return { ok: false, reason: 'cap' };
    }
    if (tier === 'integrate' && used.tokens >= limits.integrate.maxTokensPerDay) {
      return { ok: false, reason: 'tokens' };
    }
    return { ok: true };
  }

  /**
   * `allow` plus a slot held until `record`: a call in flight counts against
   * the cap, so concurrent triggers can never start more calls than are left.
   * Synchronous, so check and hold cannot interleave.
   */
  reserve(tier: WatcherTier): BudgetDecision {
    const decision = this.allow(tier);
    if (decision.ok) this.inFlight[tier] += 1;
    return decision;
  }

  /** One call made (successful or not: the backend was still called). Releases a reservation. */
  record(tier: WatcherTier, usage: { tokens?: number; costUsd?: number }): TierUsage {
    if (this.inFlight[tier] > 0) this.inFlight[tier] -= 1;
    const day = this.current();
    const u = day[tier];
    u.calls += 1;
    u.tokens += usage.tokens && usage.tokens > 0 ? usage.tokens : 0;
    u.costUsd += usage.costUsd && usage.costUsd > 0 ? usage.costUsd : 0;
    this.persist(day);
    return { ...u };
  }

  used(tier: WatcherTier): TierUsage {
    return { ...this.current()[tier] };
  }

  /** True the first time it is asked for a tier on a given day (persisted): one "capped" row a day. */
  firstCapToday(tier: WatcherTier): boolean {
    const day = this.current();
    if (day.capLogged.includes(tier)) return false;
    day.capLogged.push(tier);
    this.persist(day);
    return true;
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private current(): BudgetDay {
    const date = this.today();
    if (this.day?.date === date) return this.day;
    this.day = this.load(date);
    return this.day;
  }

  private load(date: string): BudgetDay {
    const fresh: BudgetDay = {
      date,
      notice: emptyUsage(),
      integrate: emptyUsage(),
      capLogged: [],
    };
    try {
      const path = budgetFile(this.deps.dir, date);
      if (!existsSync(path)) return fresh;
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BudgetDay>;
      return {
        date,
        notice: usageOf(raw.notice),
        integrate: usageOf(raw.integrate),
        capLogged: Array.isArray(raw.capLogged)
          ? raw.capLogged.filter((t): t is WatcherTier => t === 'notice' || t === 'integrate')
          : [],
      };
    } catch {
      return fresh;
    }
  }

  private persist(day: BudgetDay): void {
    try {
      mkdirSync(this.deps.dir, { recursive: true });
      const path = budgetFile(this.deps.dir, day.date);
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(day), 'utf-8');
      renameSync(tmp, path);
    } catch {
      // the in-memory count still caps this process
    }
  }
}

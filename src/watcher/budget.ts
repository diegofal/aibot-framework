/**
 * The watcher's daily LLM budget (phase 2). One file per UTC day,
 * `<dir>/budget-YYYY-MM-DD.json`, with calls, tokens and cost per tier, so a
 * restart never resets the count. `allow(tier)` is consulted before every
 * call: it refuses once the tier's daily cap (calls, and tokens for integrate)
 * is reached, and while the fleet circuit breaker is open for the tier's
 * backend (`isCircuitOpen`). Never throws on disk errors: an unreadable file
 * is an empty day, a failed write keeps the in-memory count.
 *
 * Monthly ceiling (autonomy rung 0, invariant C6): with `monthlyCeilingUsd`
 * set, every call of either tier is refused (`'ceiling'`) once the cost of
 * this UTC month (`monthToDate`, summed from the same budget files, so a
 * restart never resets it) reaches the ceiling; a ceiling of 0 refuses
 * everything. It is checked first, before the breaker and the daily caps.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
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

/** Why the budget refused a call: daily cap, integrate tokens, open breaker, monthly ceiling. */
export type BudgetRefusal = 'cap' | 'tokens' | 'breaker' | 'ceiling';

export type BudgetDecision = { ok: true } | { ok: false; reason: BudgetRefusal };

/** What `firstCapToday` remembers: a tier's daily cap, or the monthly ceiling. */
export type CapKind = WatcherTier | 'ceiling';

interface BudgetDay {
  date: string;
  notice: TierUsage;
  integrate: TierUsage;
  /** Tiers (or the ceiling) whose "capped" row was already logged today. */
  capLogged: CapKind[];
}

export interface DailyBudgetDeps {
  dir: string;
  limits: () => BudgetLimits;
  now?: () => number;
  /** True while the fleet breaker is open for the backend this tier calls. */
  isCircuitOpen?: (tier: WatcherTier) => boolean;
  /**
   * The monthly ceiling in USD, read on every check (live config:
   * `watcher.autonomy.monthlyCeilingUsd`, so a change applies without a
   * restart). Undefined = no ceiling.
   */
  monthlyCeilingUsd?: () => number | undefined;
}

const BUDGET_FILE = /^budget-(\d{4}-\d{2}-\d{2})\.json$/;

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
  /**
   * The cost of this month's days before `date`. Past days are immutable for
   * the running process (`record` only ever writes today's file), so the
   * month's files are read once per day, not once per call.
   */
  private pastCost: { date: string; costUsd: number } | null = null;

  constructor(private readonly deps: DailyBudgetDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The watcher dir the budget files live in (pass records sit next to them). */
  get dir(): string {
    return this.deps.dir;
  }

  allow(tier: WatcherTier): BudgetDecision {
    const ceiling = this.monthlyCeilingUsd();
    // Cost is known only after a call, so this check is before it: the last
    // call allowed below the ceiling (and any already in flight) can overshoot
    // it by its own cost. Every call after that is refused.
    if (ceiling !== undefined && this.monthToDate() >= ceiling) {
      return { ok: false, reason: 'ceiling' };
    }
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

  /** The configured monthly ceiling (USD, ≥ 0), or undefined without one. Never throws. */
  monthlyCeilingUsd(): number | undefined {
    let value: number | undefined;
    try {
      value = this.deps.monthlyCeilingUsd?.();
    } catch {
      return undefined;
    }
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
  }

  /**
   * USD spent by both tiers in the UTC month of `nowMs` (default now), up to
   * that day: the budget files of the month's earlier days plus that day
   * (today: the in-memory count, which includes what earlier processes wrote
   * today). Files of other months, of later days, or that do not parse count
   * as nothing. Never throws.
   */
  monthToDate(nowMs: number = this.now()): number {
    const date = new Date(nowMs).toISOString().slice(0, 10);
    const day = date === this.today() ? this.current() : this.load(date);
    return this.pastCostBefore(date) + day.notice.costUsd + day.integrate.costUsd;
  }

  private pastCostBefore(date: string): number {
    if (this.pastCost?.date === date) return this.pastCost.costUsd;
    const month = date.slice(0, 7);
    let costUsd = 0;
    let names: string[] = [];
    try {
      names = readdirSync(this.deps.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const fileDate = BUDGET_FILE.exec(name)?.[1];
      if (!fileDate || fileDate.slice(0, 7) !== month || fileDate >= date) continue;
      const d = this.load(fileDate);
      costUsd += d.notice.costUsd + d.integrate.costUsd;
    }
    this.pastCost = { date, costUsd };
    return costUsd;
  }

  /** True the first time it is asked for a tier (or the ceiling) on a given day (persisted): one "capped" row a day. */
  firstCapToday(tier: CapKind): boolean {
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
          ? raw.capLogged.filter(
              (t): t is CapKind => t === 'notice' || t === 'integrate' || t === 'ceiling'
            )
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

/** The row the watcher writes (once a day) when the monthly ceiling refuses a call. */
export function narrateCeilingReached(input: { costUsd: number; ceilingUsd: number }): string {
  return `Reached this month's spending ceiling ($${input.costUsd.toFixed(2)} of $${input.ceilingUsd.toFixed(2)}). I make no model calls until the month ends or you raise the ceiling.`;
}

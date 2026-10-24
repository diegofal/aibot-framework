/**
 * Stakes (docs/plans/watcher-optimizations-plan.md, O3): interoception that
 * shapes behaviour. Phase 4 computed how the watcher is (`self-model.ts`) and
 * only showed it to the integrate model; these rules make it change what the
 * watcher does. Each is one line of policy, pure over the interoceptive
 * record, today's budget and the fleet karma trend:
 *
 * - budget pressure: a tier with ≥ 75 % of today's budget used (calls, and
 *   tokens for integrate) doubles its wake line (be choosier);
 * - operator silence: silent > 48 h → question broadcasts are kept back (the
 *   insight stays on the agenda); wrote within the last hour → the kept ones go
 *   out at once (`operatorPresent`). An operator never seen is neither;
 * - breaker open: a tier whose backend's fleet breaker is open sleeps
 *   (explicit, instead of every wake being refused by `DailyBudget.reserve`);
 * - fleet karma falling: the mean down ≥ 5 from its 24 h peak → the next
 *   integrate prompt opens with "## Something is wrong".
 *
 * The watcher logs one `stakes:<rule>` row when a rule starts firing
 * (`newlyFired`) and puts the fired rules of a tier on that tier's pass row
 * (`drivenBy`, `stakesFor`), so introspection can name them as causes.
 * `KarmaTrend` keeps the karma samples and when the operator last wrote
 * (`<dir>/stakes.json`, so a restart does not forget it). Never throws.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TierUsage, WatcherTier } from './budget';
import type { Interoception } from './self-model';
import type { WatcherPhase } from './types';

/** Share of a tier's daily budget at which it gets choosier. */
export const BUDGET_PRESSURE_SHARE = 0.75;
/** Wake-line multiplier under budget pressure. */
export const BUDGET_PRESSURE_FACTOR = 2;
/** Operator silence (hours) after which questions are kept back. */
export const OPERATOR_SILENT_HOURS = 48;
/** The operator wrote within this many hours: kept questions go out. */
export const OPERATOR_PRESENT_HOURS = 1;
/** Fleet mean karma points below its 24 h peak that mean something is wrong. */
export const KARMA_DROP_POINTS = 5;
export const KARMA_WINDOW_MS = 24 * 3_600_000;
/** Karma samples are kept at most this often. */
export const KARMA_SAMPLE_EVERY_MS = 10 * 60_000;

export const STAKE_RULES = [
  'noticeBudgetPressure',
  'integrateBudgetPressure',
  'operatorSilence',
  'operatorPresent',
  'breakerOpen',
  'fleetKarmaFalling',
] as const;
export type StakeRule = (typeof STAKE_RULES)[number];

/** The phase a rule's `stakes:<rule>` row is logged under (the tier it shapes). */
export const STAKE_PHASE: Record<StakeRule, WatcherPhase> = {
  noticeBudgetPressure: 'notice',
  integrateBudgetPressure: 'integrate',
  operatorSilence: 'broadcast',
  operatorPresent: 'broadcast',
  breakerOpen: 'sense',
  fleetKarmaFalling: 'integrate',
};

/** The rules each tier's pass row carries in `drivenBy`. */
const TIER_RULES: Record<WatcherTier, readonly StakeRule[]> = {
  notice: ['noticeBudgetPressure'],
  integrate: ['integrateBudgetPressure', 'operatorSilence', 'fleetKarmaFalling'],
};

export interface StakesInput {
  interoception: Pick<Interoception, 'breakerOpen' | 'operatorSilenceHours' | 'fleetKarmaAvg'>;
  budget: { notice: TierUsage; integrate: TierUsage };
  limits: {
    notice: { maxPerDay: number };
    integrate: { maxPerDay: number; maxTokensPerDay: number };
  };
  /** The backend each tier calls (what the breaker is asked about). */
  backends: Partial<Record<WatcherTier, string>>;
  /** Highest fleet mean karma in the last 24 h (`KarmaTrend.peak`); null = no history. */
  karmaPeak?: number | null;
}

export interface Stakes {
  /** The rules firing now, in `STAKE_RULES` order. */
  fired: StakeRule[];
  noticeWakeFactor: number;
  integrateWakeFactor: number;
  deferQuestions: boolean;
  releaseQuestions: boolean;
  asleep: Record<WatcherTier, boolean>;
  /** The "## Something is wrong" line, when fleet karma is falling. */
  somethingWrong?: string;
  /** One first-person line per fired rule (the `stakes:<rule>` row text). */
  notes: Partial<Record<StakeRule, string>>;
}

const share = (used: number, cap: number) => (cap > 0 ? used / cap : 0);
const pct = (n: number) => `${Math.round(n * 100)} %`;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function stakes(input: StakesInput): Stakes {
  const fired = new Set<StakeRule>();
  const notes: Partial<Record<StakeRule, string>> = {};
  const fire = (rule: StakeRule, note: string) => {
    fired.add(rule);
    notes[rule] = note;
  };

  const noticeShare = share(input.budget.notice.calls, input.limits.notice.maxPerDay);
  if (noticeShare >= BUDGET_PRESSURE_SHARE) {
    fire(
      'noticeBudgetPressure',
      `I have used ${pct(noticeShare)} of today's notice budget, so I am choosier: notice now wakes at twice its usual salience.`
    );
  }
  const integrateShare = Math.max(
    share(input.budget.integrate.calls, input.limits.integrate.maxPerDay),
    share(input.budget.integrate.tokens, input.limits.integrate.maxTokensPerDay)
  );
  if (integrateShare >= BUDGET_PRESSURE_SHARE) {
    fire(
      'integrateBudgetPressure',
      `I have used ${pct(integrateShare)} of today's integrate budget, so I am choosier: integration now wakes at twice its usual salience.`
    );
  }

  const silence = input.interoception.operatorSilenceHours;
  if (typeof silence === 'number' && Number.isFinite(silence)) {
    if (silence > OPERATOR_SILENT_HOURS) {
      fire(
        'operatorSilence',
        `The operator has been silent for ${Math.round(silence)} h, so I hold my questions until they write.`
      );
    } else if (silence <= OPERATOR_PRESENT_HOURS) {
      fire(
        'operatorPresent',
        'The operator wrote within the last hour, so any question I held goes out now.'
      );
    }
  }

  const open = new Set(input.interoception.breakerOpen ?? []);
  const asleep: Record<WatcherTier, boolean> = {
    notice: !!input.backends.notice && open.has(input.backends.notice),
    integrate: !!input.backends.integrate && open.has(input.backends.integrate),
  };
  if (asleep.notice || asleep.integrate) {
    const tiers = (['notice', 'integrate'] as const).filter((t) => asleep[t]);
    fire(
      'breakerOpen',
      `The fleet breaker is open for ${[...new Set(tiers.map((t) => input.backends[t]))].join(', ')}, so my ${tiers.join(' and ')} tier sleeps until it closes.`
    );
  }

  let somethingWrong: string | undefined;
  const avg = input.interoception.fleetKarmaAvg;
  const peak = input.karmaPeak;
  if (
    typeof avg === 'number' &&
    typeof peak === 'number' &&
    Number.isFinite(avg) &&
    Number.isFinite(peak) &&
    peak - avg >= KARMA_DROP_POINTS
  ) {
    somethingWrong = `The fleet's mean karma fell from ${round1(peak)} to ${round1(avg)} within 24 h.`;
    fire(
      'fleetKarmaFalling',
      `${somethingWrong} I will look for a shared cause first in my next integration.`
    );
  }

  return {
    fired: STAKE_RULES.filter((r) => fired.has(r)),
    noticeWakeFactor: fired.has('noticeBudgetPressure') ? BUDGET_PRESSURE_FACTOR : 1,
    integrateWakeFactor: fired.has('integrateBudgetPressure') ? BUDGET_PRESSURE_FACTOR : 1,
    deferQuestions: fired.has('operatorSilence'),
    releaseQuestions: fired.has('operatorPresent'),
    asleep,
    ...(somethingWrong ? { somethingWrong } : {}),
    notes,
  };
}

/** The fired rules that shape `tier`'s pass (its pass row's `drivenBy`). */
export function stakesFor(tier: WatcherTier, s: Pick<Stakes, 'fired'>): StakeRule[] {
  return s.fired.filter((r) => TIER_RULES[tier].includes(r));
}

/** The fired rules that were not firing before (each gets one row). */
export function newlyFired(before: ReadonlySet<StakeRule>, s: Pick<Stakes, 'fired'>): StakeRule[] {
  return s.fired.filter((r) => !before.has(r));
}

/** Fleet mean karma samples over the last 24 h, persisted so a restart keeps the trend. */
export class KarmaTrend {
  private samples: Array<{ at: number; avg: number }> = [];
  private lastOperatorAt: number | null = null;

  constructor(private readonly file: string) {
    try {
      if (!existsSync(file)) return;
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
        karma?: unknown;
        lastOperatorAt?: unknown;
      };
      if (typeof raw.lastOperatorAt === 'number' && Number.isFinite(raw.lastOperatorAt)) {
        this.lastOperatorAt = raw.lastOperatorAt;
      }
      if (!Array.isArray(raw.karma)) return;
      this.samples = raw.karma.filter(
        (s): s is { at: number; avg: number } =>
          !!s &&
          typeof (s as { at?: unknown }).at === 'number' &&
          typeof (s as { avg?: unknown }).avg === 'number'
      );
    } catch {
      this.samples = [];
    }
  }

  /** Keep a sample (at most every `KARMA_SAMPLE_EVERY_MS`), drop those past the window. */
  record(nowMs: number, avg: number | null): void {
    if (typeof avg !== 'number' || !Number.isFinite(avg)) return;
    const last = this.samples.at(-1);
    if (last && nowMs - last.at < KARMA_SAMPLE_EVERY_MS) return;
    this.samples = this.samples.filter((s) => nowMs - s.at <= KARMA_WINDOW_MS);
    this.samples.push({ at: nowMs, avg });
    this.save();
  }

  /** When the operator last wrote, as persisted (survives a restart); null before they ever did. */
  operatorAt(): number | null {
    return this.lastOperatorAt;
  }

  /** Keep when the operator last wrote (only a later time moves it). */
  setOperatorAt(ms: number | null): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
    if (this.lastOperatorAt !== null && ms <= this.lastOperatorAt) return;
    this.lastOperatorAt = ms;
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(
        tmp,
        JSON.stringify({
          version: 1,
          karma: this.samples,
          ...(this.lastOperatorAt !== null ? { lastOperatorAt: this.lastOperatorAt } : {}),
        }),
        'utf-8'
      );
      renameSync(tmp, this.file);
    } catch {
      // a lost trend is a cold start
    }
  }

  /** The highest sample within the last 24 h; null without one. */
  peak(nowMs: number): number | null {
    let best: number | null = null;
    for (const s of this.samples) {
      if (nowMs - s.at > KARMA_WINDOW_MS) continue;
      if (best === null || s.avg > best) best = s.avg;
    }
    return best;
  }
}

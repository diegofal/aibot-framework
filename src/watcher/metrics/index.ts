/**
 * The watcher's metric table (docs/plans/watcher-consciousness-plan.md, "How
 * success is measured"): the seven metrics (1 and 1b both integration) plus
 * the four guards, computed only from records (neurons, broadcasts, cycle
 * rows, budget days, canaries, introspection, the bots' knowledge maps, the
 * phase 0 baseline), so they can be recomputed at any time without the
 * watcher's memory. Pure and total: empty records give each metric its
 * baseline, never NaN. The live semaphore snapshot is the one exception the
 * conversation-latency guard accepts, and it is optional.
 */
import { textSimilarity } from '../../hygiene/text-utils';
import type { Broadcast } from '../broadcast';
import type { TierUsage } from '../budget';
import { servedFromCycles } from '../outcomes';
import type { Neuron } from '../types';
import { idleCycleShare, medianCycleIntervalMs } from './baseline';
import {
  type FieldVerdict,
  type IntrospectionSubjectSummary,
  summarizeIntrospection,
} from './introspection';

export type MetricsWindow = '7d' | '30d';

export const METRIC_IDS = [
  'crossSource',
  'contradictions',
  'latency',
  'introspection',
  'calibration',
  'compounding',
  'causal',
  'surprises',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export const GUARD_IDS = ['cost', 'idle', 'conversation', 'interruptions'] as const;
export type GuardId = (typeof GUARD_IDS)[number];

/** Same threshold the plan dedupes surprises at against KNOWLEDGE.json. */
export const SURPRISE_DEDUPE = 0.8;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const OLD_NEURON_MS = 7 * DAY_MS;

export interface MetricsCycleRow {
  cycleId: string;
  botId?: string;
  startedAt: string;
  endedAt?: string;
  status?: string;
  servesBroadcast?: string;
}

export interface MetricsRecords {
  nowMs: number;
  neurons: Neuron[];
  broadcasts: Broadcast[];
  cycles: MetricsCycleRow[];
  budgetDays: Array<{ date: string; notice: TierUsage; integrate: TierUsage }>;
  limits: {
    notice: { maxPerDay: number };
    integrate: { maxPerDay: number; maxTokensPerDay: number };
  };
  /** `canaries.jsonl` rows (phase 0 script): plants and checks. */
  canaries: Array<{ kind?: string; checkedAt?: string; plantedAt?: string; found?: boolean }>;
  /** `introspection.jsonl` rows (phase 0 script). */
  introspection: Array<{
    ts?: string;
    subject?: string;
    score?: number;
    fields?: Partial<Record<'phase' | 'tool' | 'goal' | 'cause', FieldVerdict>>;
  }>;
  /** Every bot's KNOWLEDGE.json surprises (text). */
  knowledgeSurprises: string[];
  /** Fleet idle share from the latest phase 0 baseline report, when there is one. */
  baselineIdleShare?: number;
  /** `operator.proactiveDailyCap`: watcher questions share it. */
  proactiveDailyCap: number;
  /** Live Claude CLI semaphore snapshot (optional). */
  semaphore?: { queuedInteractive: number; activeWatcher: number };
}

export interface WatcherMetric {
  id: MetricId;
  label: string;
  value: number;
  baseline: number;
  target: string;
  unit: 'share' | 'perWeek' | 'ms' | 'score' | 'brier';
  /** Records the value stands on; 0 = the value is the baseline. */
  n: number;
  detail?: Record<string, number>;
  /** Metric 3 only (phase 4): one summary per subject in the window. */
  subjects?: IntrospectionSubjectSummary[];
}

export interface WatcherGuard {
  id: GuardId;
  label: string;
  value: number;
  limit: number;
  unit: 'usd' | 'share' | 'count';
  over: boolean;
  detail?: Record<string, number>;
}

export interface WatcherMetrics {
  window: MetricsWindow;
  from: string;
  to: string;
  metrics: WatcherMetric[];
  guards: WatcherGuard[];
}

export function parseMetricsWindow(raw: string | undefined): MetricsWindow | null {
  if (raw === undefined || raw === '') return '7d';
  return raw === '7d' || raw === '30d' ? raw : null;
}

export function windowMs(window: MetricsWindow): number {
  return window === '30d' ? 30 * DAY_MS : 7 * DAY_MS;
}

export function emptyRecords(nowMs: number): MetricsRecords {
  return {
    nowMs,
    neurons: [],
    broadcasts: [],
    cycles: [],
    budgetDays: [],
    limits: { notice: { maxPerDay: 0 }, integrate: { maxPerDay: 0, maxTokensPerDay: 0 } },
    canaries: [],
    introspection: [],
    knowledgeSurprises: [],
    proactiveDailyCap: 0,
  };
}

const ms = (iso: string | undefined): number => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : Number.NaN;
};

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

/** Finite or the fallback: no NaN ever leaves this module. */
const fin = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);

export function computeMetrics(records: MetricsRecords, window: MetricsWindow): WatcherMetrics {
  const now = records.nowMs;
  const span = windowMs(window);
  const from = now - span;
  const weeks = span / WEEK_MS;
  const inWindow = (iso: string | undefined) => {
    const t = ms(iso);
    return Number.isFinite(t) && t >= from && t <= now;
  };
  const neurons = Array.isArray(records.neurons) ? records.neurons : [];
  const created = (kind: Neuron['kind']) =>
    neurons.filter((n) => n.kind === kind && inWindow(n.createdAt));

  const metrics: WatcherMetric[] = [];
  const push = (m: Omit<WatcherMetric, 'value'> & { value: number }) =>
    metrics.push({ ...m, value: m.n === 0 ? m.baseline : fin(m.value, m.baseline) });

  // 1. Cross-source insight share
  const insights = created('insight');
  const cross = insights.filter(
    (n) =>
      n.support.bots.length >= 2 ||
      (n.support.bots.length >= 1 && (n.support.conversations?.length ?? 0) >= 1)
  ).length;
  push({
    id: 'crossSource',
    label: 'Cross-source insight share',
    value: insights.length ? cross / insights.length : 0,
    baseline: 0,
    target: '≥ 30 %',
    unit: 'share',
    n: insights.length,
    detail: { insights: insights.length, crossSource: cross },
  });

  // 1b. Contradictions surfaced (operator 👍 = confirmed, 👎 = dismissed)
  const contradictions = created('contradiction');
  const confirmed = contradictions.filter((n) => n.meta?.signal === 'up').length;
  const dismissed = contradictions.filter((n) => n.meta?.signal === 'down').length;
  push({
    id: 'contradictions',
    label: 'Contradictions confirmed per week',
    value: confirmed / weeks,
    baseline: 0,
    target: '≥ 1 / week, ≤ 50 % dismissed',
    unit: 'perWeek',
    n: contradictions.length,
    detail: {
      flagged: contradictions.length,
      confirmed,
      dismissed,
      dismissedShare: confirmed + dismissed ? dismissed / (confirmed + dismissed) : 0,
    },
  });

  // 2. Latency to notice (event → neuron), tier 1; tier 2 apart
  const cycles = (Array.isArray(records.cycles) ? records.cycles : []).filter((c) =>
    inWindow(c.startedAt)
  );
  const latencyOf = (source: string) =>
    neurons
      .filter((n) => n.meta?.source === source && n.meta?.eventAt && inWindow(n.createdAt))
      .map((n) => ms(n.createdAt) - ms(n.meta?.eventAt))
      .filter((x) => Number.isFinite(x) && x >= 0);
  const noticeLat = latencyOf('notice');
  const integrateLat = latencyOf('integrate');
  push({
    id: 'latency',
    label: 'Latency to notice (median)',
    value: median(noticeLat),
    baseline: fin(medianCycleIntervalMs(cycles)),
    target: 'tier 1 < 5 min, tier 2 < 1 h',
    unit: 'ms',
    n: noticeLat.length,
    detail: {
      p95: p95(noticeLat),
      integrateMedian: median(integrateLat),
      integrateN: integrateLat.length,
    },
  });

  // 3. Introspection match rate
  const intro = (Array.isArray(records.introspection) ? records.introspection : []).filter(
    (r) => inWindow(r.ts) && typeof r.score === 'number' && Number.isFinite(r.score)
  );
  const bySubject: Record<string, number> = {};
  for (const subject of new Set(intro.map((r) => r.subject ?? 'unknown'))) {
    bySubject[subject] = mean(
      intro.filter((r) => (r.subject ?? 'unknown') === subject).map((r) => r.score as number)
    );
  }
  push({
    id: 'introspection',
    label: 'Introspection match rate',
    value: mean(intro.map((r) => r.score as number)),
    baseline: 0,
    target: 'watcher ≥ 80 %',
    unit: 'score',
    n: intro.length,
    detail: bySubject,
    subjects: summarizeIntrospection(intro),
  });

  // 4. Calibration (Brier over predictions resolved in the window)
  const resolved = neurons.filter(
    (n) =>
      n.kind === 'prediction' &&
      inWindow(n.meta?.resolvedAt) &&
      Number.isFinite(Number(n.meta?.brier)) &&
      n.meta?.brier !== undefined
  );
  const happenedRate = mean(resolved.map((n) => (n.meta?.happened === 'true' ? 1 : 0)));
  push({
    id: 'calibration',
    label: 'Prediction calibration (Brier)',
    value: mean(resolved.map((n) => Number(n.meta?.brier))),
    baseline: 0.25,
    target: 'below the frequency baseline, improving weekly',
    unit: 'brier',
    n: resolved.length,
    detail: {
      resolved: resolved.length,
      frequencyBrier: resolved.length ? happenedRate * (1 - happenedRate) : 0.25,
      open: neurons.filter((n) => n.kind === 'prediction' && !n.meta?.resolvedAt).length,
    },
  });

  // 5. Compounding and forgetting
  const cited = new Set(
    insights.flatMap((n) => (n.meta?.supportNeurons ?? '').split(',').filter(Boolean))
  );
  const old = neurons.filter(
    (n) => !n.archivedAt && ms(n.createdAt) < now - OLD_NEURON_MS && n.kind !== 'insight'
  );
  const reactivated = old.filter((n) => cited.has(n.id)).length;
  const checks = (Array.isArray(records.canaries) ? records.canaries : []).filter(
    (c) => c.kind === 'check' && inWindow(c.checkedAt)
  );
  push({
    id: 'compounding',
    label: 'Re-activation of old knowledge',
    value: old.length ? reactivated / old.length : 0,
    baseline: 0,
    target: '≥ 20 %; canary recall ≥ 70 %',
    unit: 'share',
    n: old.length,
    detail: {
      prunedShare: neurons.length
        ? neurons.filter((n) => !!n.archivedAt).length / neurons.length
        : 0,
      canaryRecall: checks.length
        ? checks.filter((c) => c.found === true).length / checks.length
        : 0,
      canaryChecks: checks.length,
    },
  });

  // 6. Broadcasts that changed behaviour
  const broadcasts = (Array.isArray(records.broadcasts) ? records.broadcasts : []).filter((b) =>
    inWindow(b.createdAt)
  );
  const delivered = broadcasts.filter((b) => !!b.deliveredAt);
  const servedByRows = new Set(servedFromCycles(delivered, records.cycles ?? []).map((s) => s.id));
  const served = delivered.filter((b) => !!b.servedByCycle || servedByRows.has(b.id)).length;
  push({
    id: 'causal',
    label: 'Broadcasts served by a cycle',
    value: delivered.length ? served / delivered.length : 0,
    baseline: 0,
    target: '≥ 50 % served; 👍 ≥ 👎',
    unit: 'share',
    n: delivered.length,
    detail: {
      delivered: delivered.length,
      failed: broadcasts.length - delivered.length,
      served,
      up: broadcasts.filter((b) => b.signal === 'up').length,
      down: broadcasts.filter((b) => b.signal === 'down').length,
    },
  });

  // 7. Novel surprises per week
  const known = (
    Array.isArray(records.knowledgeSurprises) ? records.knowledgeSurprises : []
  ).filter((s) => typeof s === 'string' && s.trim());
  const surprises = created('surprise').filter((n) => n.createdBy === 'watcher');
  const novel = surprises.filter(
    (n) => !known.some((k) => textSimilarity(k, n.text) >= SURPRISE_DEDUPE)
  ).length;
  push({
    id: 'surprises',
    label: 'Novel fleet surprises per week',
    value: novel / weeks,
    baseline: 0,
    target: '≥ 3 / week',
    unit: 'perWeek',
    n: surprises.length,
    detail: { surprises: surprises.length, novel },
  });

  return {
    window,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    metrics,
    guards: guards(records, { from, now, cycles, broadcasts }),
  };
}

function guards(
  records: MetricsRecords,
  ctx: { from: number; now: number; cycles: MetricsCycleRow[]; broadcasts: Broadcast[] }
): WatcherGuard[] {
  const fromDay = new Date(ctx.from).toISOString().slice(0, 10);
  const days = (Array.isArray(records.budgetDays) ? records.budgetDays : []).filter(
    (d) => typeof d.date === 'string' && d.date >= fromDay
  );
  const usd = (u: TierUsage | undefined) => fin(u?.costUsd ?? 0);
  const noticeUsd = days.reduce((s, d) => s + usd(d.notice), 0);
  const integrateUsd = days.reduce((s, d) => s + usd(d.integrate), 0);
  const maxCalls = Math.max(0, ...days.map((d) => fin(d.integrate?.calls ?? 0)));
  const maxTokens = Math.max(0, ...days.map((d) => fin(d.integrate?.tokens ?? 0)));
  const limits = records.limits?.integrate ?? { maxPerDay: 0, maxTokensPerDay: 0 };
  const costOver =
    days.length > 0 &&
    (maxCalls > limits.maxPerDay ||
      (limits.maxTokensPerDay > 0 && maxTokens > limits.maxTokensPerDay));

  const idle = fin(idleCycleShare(ctx.cycles));
  const baselineIdle =
    typeof records.baselineIdleShare === 'number' && Number.isFinite(records.baselineIdleShare)
      ? records.baselineIdleShare
      : undefined;

  const sem = records.semaphore;
  const queued = fin(sem?.queuedInteractive ?? 0);

  const perDay = new Map<string, number>();
  for (const b of ctx.broadcasts) {
    if (b.kind !== 'question' || b.deliveryError) continue;
    const day = b.createdAt.slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const maxQuestions = Math.max(0, ...perDay.values());
  const cap = fin(records.proactiveDailyCap ?? 0);

  return [
    {
      id: 'cost',
      label: 'Watcher LLM cost',
      value: noticeUsd + integrateUsd,
      limit: limits.maxPerDay,
      unit: 'usd',
      over: costOver,
      detail: {
        noticeUsd,
        integrateUsd,
        maxIntegrateCallsPerDay: maxCalls,
        maxIntegrateTokensPerDay: maxTokens,
      },
    },
    {
      id: 'idle',
      label: 'Bot idle cycles',
      value: idle,
      limit: baselineIdle ?? idle,
      unit: 'share',
      over: baselineIdle !== undefined && ctx.cycles.length > 0 && idle > baselineIdle,
      detail: { cycles: ctx.cycles.length },
    },
    {
      id: 'conversation',
      label: 'Conversations waiting on the watcher',
      value: queued,
      limit: 0,
      unit: 'count',
      over: !!sem && queued > 0 && fin(sem.activeWatcher) > 0,
      detail: { activeWatcher: fin(sem?.activeWatcher ?? 0) },
    },
    {
      id: 'interruptions',
      label: 'Operator questions per day',
      value: maxQuestions,
      limit: cap,
      unit: 'count',
      over: cap > 0 && maxQuestions > cap,
    },
  ];
}

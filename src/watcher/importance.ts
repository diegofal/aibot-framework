/**
 * O10 (`docs/plans/watcher-optimizations-plan.md`): how much a neuron matters,
 * from what is already recorded. Pure and deterministic; no model ever scores.
 *
 * | Component    | Source                                                          | Weight |
 * |--------------|-----------------------------------------------------------------|--------|
 * | use          | `activations`, decayed by `lastActivatedAt` (half-life 14 d)     | 0.25   |
 * | consequence  | supports an insight (edge or `meta.supportNeurons`, served or not; ids resolved through `mergedInto`, so a summary inherits what its members supported), a resolved prediction, a served broadcast | 0.35 |
 * | breadth      | distinct `support.bots` + `related` edges (log-scaled)           | 0.15   |
 * | surprise     | kind `surprise` / `contradiction`, or `meta.novel`               | 0.10   |
 * | operator     | 👍 = +1 (protected), 👎 = −1                                     | 0.15   |
 *
 * Protected (never forgotten nor consolidated): `entity`, `person`, `goal`;
 * anything with 👍; an insight whose broadcast a cycle served and what it
 * stands on; anything younger than `forget.graceDays`. Every score carries a
 * code-written reason ("importance 0.12: never used, one bot, no consequence"),
 * which forgetting stores as `meta.archivedReason`.
 */
import type { Edge, Neuron, NeuronKind } from './types';

export const IMPORTANCE_WEIGHTS = {
  use: 0.25,
  consequence: 0.35,
  breadth: 0.15,
  surprise: 0.1,
  operator: 0.15,
} as const;

export const USE_HALF_LIFE_MS = 14 * 86_400_000;
/** Activations at which `use` saturates (log2 scale). */
export const USE_SATURATION = 32;
/** Extra bots + related links at which `breadth` saturates (log scale). */
export const BREADTH_SATURATION = 15;
export const PROTECTED_KINDS: readonly NeuronKind[] = ['entity', 'person', 'goal'];

const DAY_MS = 86_400_000;

export type ImportanceComponents = Record<keyof typeof IMPORTANCE_WEIGHTS, number>;
/** Why a neuron is never forgotten: its kind, the operator's 👍, a served broadcast, its youth. */
export type Protection = 'kind' | 'operator' | 'served' | 'grace';

export interface ImportanceGraph {
  get(id: string): Neuron | undefined;
  edgesOf(id: string): Edge[];
  /** Every neuron; read once per context to find what insights name in `meta.supportNeurons`. */
  list?(): Neuron[];
}

export interface ImportanceContext {
  nowMs: number;
  graph: ImportanceGraph;
  /** `forget.graceDays`: younger neurons are protected. */
  graceDays: number;
  /** Insight ids with a broadcast a cycle served (`Broadcast.servedByCycle`). */
  servedInsights: ReadonlySet<string>;
}

export interface ImportanceScore {
  /** 0–1. */
  score: number;
  components: ImportanceComponents;
  protected: Protection | null;
  /** "importance 0.12: never used, one bot, no consequence". */
  reason: string;
}

const PROTECTION_TEXT: Record<Protection, string> = {
  kind: 'an agent, a person or a goal',
  operator: 'the operator gave it 👍',
  served: 'behind a broadcast a cycle served',
  grace: 'too young to forget',
};

const isResolvedPrediction = (n: Neuron | undefined): boolean =>
  !!n && n.kind === 'prediction' && !!n.meta?.resolvedAt;

interface Consequence {
  insight: boolean;
  prediction: boolean;
  served: boolean;
}

function consequenceOf(n: Neuron, ctx: ImportanceContext): Consequence {
  const out: Consequence = { insight: false, prediction: false, served: false };
  if (n.kind === 'insight' && ctx.servedInsights.has(n.id)) out.served = true;
  if (isResolvedPrediction(n)) out.prediction = true;
  for (const e of ctx.graph.edgesOf(n.id)) {
    if (e.rel === 'caused' && e.from === n.id) {
      const to = ctx.graph.get(e.to);
      if (to?.kind === 'insight') {
        out.insight = true;
        if (ctx.servedInsights.has(to.id)) out.served = true;
      }
    } else if (e.rel === 'predicts' && e.to === n.id) {
      if (isResolvedPrediction(ctx.graph.get(e.from))) out.prediction = true;
    }
  }
  // An insight names what it stands on in `meta.supportNeurons` too:
  // supporting any live insight is a consequence, a served one protects.
  const named = insightSupportOf(ctx).get(n.id);
  if (named) {
    out.insight = true;
    if (named.some((id) => ctx.servedInsights.has(id))) out.served = true;
  }
  if (!out.served) {
    for (const id of ctx.servedInsights) {
      const insight = ctx.graph.get(id);
      const ids = (insight?.meta?.supportNeurons?.split(',') ?? []).map((x) =>
        resolveMergedId(ctx.graph, x.trim())
      );
      if (ids.includes(n.id)) {
        out.served = true;
        out.insight = true;
        break;
      }
    }
  }
  return out;
}

/** Most merges followed from an archived id to its keeper (as `Graph.resolveMerged`). */
const MAX_MERGE_HOPS = 10;

/**
 * The id a support reference stands for now: an archived neuron merged or
 * consolidated into another (`meta.mergedInto`) resolves to its keeper, so an
 * insight citing facts that were consolidated supports the summary.
 */
export function resolveMergedId(graph: Pick<ImportanceGraph, 'get'>, id: string): string {
  let cur = id;
  for (let hops = 0; hops < MAX_MERGE_HOPS; hops++) {
    const n = graph.get(cur);
    const next = n?.archivedAt ? n.meta?.mergedInto : undefined;
    if (!next || !graph.get(next)) break;
    cur = next;
  }
  return cur;
}

/**
 * Per context: neuron id → the live insights that name it in
 * `meta.supportNeurons`, ids resolved through merges (`resolveMergedId`).
 */
const insightSupportCache = new WeakMap<ImportanceContext, Map<string, string[]>>();

function insightSupportOf(ctx: ImportanceContext): Map<string, string[]> {
  const cached = insightSupportCache.get(ctx);
  if (cached) return cached;
  const map = new Map<string, string[]>();
  for (const insight of ctx.graph.list?.() ?? []) {
    if (insight.kind !== 'insight' || insight.archivedAt) continue;
    for (const id of insight.meta?.supportNeurons?.split(',') ?? []) {
      const key = id.trim() && resolveMergedId(ctx.graph, id.trim());
      if (!key) continue;
      const list = map.get(key);
      if (list) list.push(insight.id);
      else map.set(key, [insight.id]);
    }
  }
  insightSupportCache.set(ctx, map);
  return map;
}

/** Why the neuron may never be forgotten, or null. */
export function protectionOf(n: Neuron, ctx: ImportanceContext): Protection | null {
  if (PROTECTED_KINDS.includes(n.kind)) return 'kind';
  if (n.meta?.signal === 'up') return 'operator';
  if (consequenceOf(n, ctx).served) return 'served';
  const created = Date.parse(n.createdAt);
  if (!Number.isFinite(created) || ctx.nowMs - created < ctx.graceDays * DAY_MS) return 'grace';
  return null;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export function importanceOf(n: Neuron, ctx: ImportanceContext): ImportanceScore {
  const activations = Math.max(0, n.activations || 0);
  const last = Date.parse(n.lastActivatedAt);
  const age = Number.isFinite(last) ? Math.max(0, ctx.nowMs - last) : Number.POSITIVE_INFINITY;
  const decay = 0.5 ** (age / USE_HALF_LIFE_MS);
  const use = clamp01(Math.log2(Math.max(1, activations)) / Math.log2(USE_SATURATION)) * decay;

  const cons = consequenceOf(n, ctx);
  const consequence = cons.insight || cons.prediction || cons.served ? 1 : 0;

  const bots = new Set(n.support?.bots ?? []).size;
  const related = ctx.graph.edgesOf(n.id).filter((e) => e.rel === 'related').length;
  const breadth = clamp01(
    Math.log(1 + Math.max(0, bots - 1) + related) / Math.log(1 + BREADTH_SATURATION)
  );

  const surprise =
    n.kind === 'surprise' || n.kind === 'contradiction' || n.meta?.novel === 'true' ? 1 : 0;
  const operator = n.meta?.signal === 'up' ? 1 : n.meta?.signal === 'down' ? -1 : 0;

  const components: ImportanceComponents = { use, consequence, breadth, surprise, operator };
  const w = IMPORTANCE_WEIGHTS;
  const score = clamp01(
    w.use * use +
      w.consequence * consequence +
      w.breadth * breadth +
      w.surprise * surprise +
      w.operator * operator
  );

  const words: string[] = [];
  words.push(
    activations <= 1
      ? 'never used'
      : `used ${activations} times, last ${Math.floor(age / DAY_MS)} d ago`
  );
  words.push(bots <= 1 ? (bots === 0 ? 'no bot' : 'one bot') : `${bots} bots`);
  if (related > 0) words.push(`${related} link${related === 1 ? '' : 's'}`);
  const consWords = [
    cons.insight && !cons.served ? 'supports an insight' : '',
    cons.prediction ? 'behind a resolved prediction' : '',
    cons.served ? 'behind a served broadcast' : '',
  ].filter(Boolean);
  words.push(consWords.length ? consWords.join(', ') : 'no consequence');
  if (surprise) words.push('a surprise');
  if (operator === 1) words.push('👍 from the operator');
  if (operator === -1) words.push('👎 from the operator');
  const prot = protectionOf(n, ctx);
  const reason = `importance ${score.toFixed(2)}: ${words.join(', ')}${
    prot ? `; protected (${PROTECTION_TEXT[prot]})` : ''
  }`;
  return { score, components, protected: prot, reason };
}

export interface ForgetPlan {
  /** Lowest importance first. */
  archive: Array<{ neuron: Neuron; score: ImportanceScore }>;
  /** Live neurons before. */
  live: number;
  /** Unprotected live neurons under the threshold (whether or not the target needs them). */
  under: number;
}

/**
 * What forgetting archives: live, unprotected neurons with importance below
 * `threshold`, lowest first (older activation breaks ties), until the live
 * graph is at most `target` or none remain under the threshold. Pure.
 */
export function planForgetting(
  neurons: Iterable<Neuron>,
  ctx: ImportanceContext,
  opts: { threshold: number; target: number }
): ForgetPlan {
  const live: Neuron[] = [];
  for (const n of neurons) if (!n.archivedAt) live.push(n);
  const candidates: Array<{ neuron: Neuron; score: ImportanceScore }> = [];
  for (const n of live) {
    const score = importanceOf(n, ctx);
    if (score.protected || score.score >= opts.threshold) continue;
    candidates.push({ neuron: n, score });
  }
  candidates.sort(
    (a, b) =>
      a.score.score - b.score.score ||
      Date.parse(a.neuron.lastActivatedAt) - Date.parse(b.neuron.lastActivatedAt) ||
      (a.neuron.id < b.neuron.id ? -1 : 1)
  );
  const excess = Math.max(0, live.length - Math.max(0, opts.target));
  return { archive: candidates.slice(0, excess), live: live.length, under: candidates.length };
}

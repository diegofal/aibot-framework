/**
 * Watcher phase 0: baseline numbers over records the fleet already writes
 * (cycle log, curiosity knowledge maps, operator chat replies). Pure, no I/O,
 * never throws on malformed input: a bad row is skipped.
 *
 * Plan: docs/plans/watcher-implementation-plan.md, "Phase 0: baseline".
 */
import { textSimilarity, titleTokens } from '../../hygiene/text-utils';

/** The slice of `AgentCycleRecord` (src/stats/readers/agent-cycles.ts) these metrics read. */
export interface BaselineCycle {
  cycleId: string;
  botId?: string;
  startedAt: string;
  status?: string;
}

/** The slice of `KnowledgeMap` (src/bot/curiosity/types.ts) these metrics read. */
export interface BaselineKnowledgeMap {
  topics: Array<{ name: string }>;
}

export interface TopicOverlap {
  /** The first name seen for the cluster. */
  topic: string;
  /** Every distinct name that fell into the cluster. */
  names: string[];
  bots: Array<{ botId: string; name: string }>;
}

export interface ChatReply {
  botId: string;
  text: string;
}

export interface CyclePlan {
  botId: string;
  cycleId: string;
  text: string;
}

export interface ContradictionCandidate {
  botId: string;
  cycleId: string;
  reply: string;
  plan: string;
  /** The exact topic words both texts contain. */
  shared: string[];
}

/** `textSimilarity` at or above which two topic names are the same topic. */
export const TOPIC_OVERLAP_THRESHOLD = 0.8;
/** Shorter tokens ("now", "fix") are too generic to call a topic. */
export const MIN_TOPIC_WORD_CHARS = 4;
/** Topic words a reply and a plan must share to be a candidate. */
export const MIN_SHARED_TOPIC_WORDS = 2;
/** Clip of the reply / plan text kept on a candidate. */
export const CANDIDATE_TEXT_MAX = 200;

/** Share (0–1) of cycles that ended idle. 0 for no cycles. */
export function idleCycleShare(cycles: BaselineCycle[]): number {
  const rows = Array.isArray(cycles) ? cycles : [];
  if (rows.length === 0) return 0;
  const idle = rows.filter((c) => c?.status === 'idle').length;
  return idle / rows.length;
}

/**
 * Median gap between consecutive cycle starts of the same bot: how long the
 * fleet takes today to look at something again (= latency to notice). 0 when
 * there are fewer than two cycles per bot.
 */
export function medianCycleIntervalMs(cycles: BaselineCycle[]): number {
  const byBot = new Map<string, number[]>();
  for (const c of Array.isArray(cycles) ? cycles : []) {
    const t = Date.parse(c?.startedAt ?? '');
    if (!Number.isFinite(t)) continue;
    const key = c.botId ?? '';
    const list = byBot.get(key) ?? [];
    list.push(t);
    byBot.set(key, list);
  }
  const gaps: number[] = [];
  for (const starts of byBot.values()) {
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) gaps.push(starts[i] - starts[i - 1]);
  }
  return median(gaps);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Topics that at least two bots study, names merged at
 * `textSimilarity ≥ TOPIC_OVERLAP_THRESHOLD`. A name repeated inside one bot
 * counts once.
 */
export function overlappingTopics(
  mapsByBot: Record<string, BaselineKnowledgeMap | undefined>
): TopicOverlap[] {
  const clusters: TopicOverlap[] = [];
  for (const [botId, map] of Object.entries(mapsByBot ?? {})) {
    const topics = Array.isArray(map?.topics) ? map.topics : [];
    for (const t of topics) {
      const name = t?.name;
      if (typeof name !== 'string' || !name.trim()) continue;
      const cluster = clusters.find((c) =>
        c.names.some((n) => textSimilarity(n, name) >= TOPIC_OVERLAP_THRESHOLD)
      );
      if (!cluster) {
        clusters.push({ topic: name, names: [name], bots: [{ botId, name }] });
        continue;
      }
      if (!cluster.names.includes(name)) cluster.names.push(name);
      if (!cluster.bots.some((b) => b.botId === botId)) cluster.bots.push({ botId, name });
    }
  }
  return clusters.filter((c) => c.bots.length >= 2);
}

function topicWords(text: string): Set<string> {
  return new Set(titleTokens(text).filter((t) => t.length >= MIN_TOPIC_WORD_CHARS));
}

/**
 * Pairs of a bot's chat reply and one of its own cycle plans that talk about
 * the same thing (≥ MIN_SHARED_TOPIC_WORDS exact topic words). Candidates for
 * a human or a later phase to judge, never verdicts.
 */
export function chatVsLoopContradictions(
  replies: ChatReply[],
  plans: CyclePlan[]
): ContradictionCandidate[] {
  const out: ContradictionCandidate[] = [];
  const planWords = (Array.isArray(plans) ? plans : [])
    .filter((p) => typeof p?.text === 'string' && p.text.trim() && typeof p.botId === 'string')
    .map((p) => ({ plan: p, words: topicWords(p.text) }));
  for (const reply of Array.isArray(replies) ? replies : []) {
    if (typeof reply?.text !== 'string' || !reply.text.trim()) continue;
    const words = topicWords(reply.text);
    for (const { plan, words: pw } of planWords) {
      if (plan.botId !== reply.botId) continue;
      const shared = [...words].filter((w) => pw.has(w));
      if (shared.length < MIN_SHARED_TOPIC_WORDS) continue;
      out.push({
        botId: reply.botId,
        cycleId: plan.cycleId,
        reply: reply.text.slice(0, CANDIDATE_TEXT_MAX),
        plan: plan.text.slice(0, CANDIDATE_TEXT_MAX),
        shared,
      });
    }
  }
  return out;
}

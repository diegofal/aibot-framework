/**
 * Per-cycle curiosity mechanics: topic concentration, explore/exploit choice,
 * frontier selection, cycle bookkeeping. Pure functions.
 */
import { evaluateFrontierItem } from './config';
import type {
  CycleMode,
  CycleTopicEntry,
  FrontierItem,
  KnowledgeMap,
  LimitDial,
  LimitDials,
  NavigatorState,
  ResolvedCuriosity,
} from './types';

export const CYCLE_LOG_CAP = 30;

export interface TopicConcentration {
  dominantTopic: string | null;
  share: number;
  count: number;
  /** Entries actually considered (≤ requested window). */
  window: number;
}

export function computeTopicConcentration(
  log: CycleTopicEntry[],
  window: number
): TopicConcentration {
  const recent = log.slice(-window);
  if (recent.length === 0) return { dominantTopic: null, share: 0, count: 0, window: 0 };
  const counts = new Map<string, number>();
  for (const e of recent) counts.set(e.topic, (counts.get(e.topic) ?? 0) + 1);
  let dominantTopic: string | null = null;
  let count = 0;
  for (const [topic, n] of counts) {
    if (n > count) {
      dominantTopic = topic;
      count = n;
    }
  }
  return { dominantTopic, share: count / recent.length, count, window: recent.length };
}

export type CycleModeReason =
  | 'disabled'
  | 'concentration'
  | 'no-surprise'
  | 'operator-silent'
  | 'budget'
  | 'default';

export interface CycleModeDecision {
  mode: CycleMode;
  reason: CycleModeReason;
}

/**
 * Explore when: one topic dominates a mostly-full window → the bot is in a
 * topical rut; nothing surprised it for `noSurpriseStreak` cycles; the explore
 * budget (every 1/ratio cycles) is due — halved while the operator is silent,
 * because silence should mean "go find something", not "idle".
 */
export function decideCycleMode(
  nav: NavigatorState,
  cfg: ResolvedCuriosity,
  opts: { operatorSilent?: boolean } = {}
): CycleModeDecision {
  if (!cfg.enabled) return { mode: 'exploit', reason: 'disabled' };

  // Rut triggers only fire once at least one exploit cycle passed since the
  // last exploration — otherwise a stuck streak would explore every cycle.
  const sinceExplore = nav.cyclesSinceExplore >= 1;
  const conc = computeTopicConcentration(nav.cycleLog, cfg.topicWindow);
  if (
    sinceExplore &&
    conc.window >= Math.ceil(cfg.topicWindow * 0.75) &&
    conc.share > cfg.maxTopicShare
  ) {
    return { mode: 'explore', reason: 'concentration' };
  }
  if (sinceExplore && nav.noSurpriseStreak >= cfg.noSurpriseStreak) {
    return { mode: 'explore', reason: 'no-surprise' };
  }
  if (cfg.exploreRatio > 0) {
    const period = Math.max(1, Math.round(1 / cfg.exploreRatio));
    const next = nav.cyclesSinceExplore + 1;
    if (next >= period) return { mode: 'explore', reason: 'budget' };
    if (opts.operatorSilent && next >= Math.max(1, Math.ceil(period / 2))) {
      return { mode: 'explore', reason: 'operator-silent' };
    }
  }
  return { mode: 'exploit', reason: 'default' };
}

/** Append a cycle and update the explore counter and the no-surprise streak. */
export function recordCycle(
  nav: NavigatorState,
  entry: CycleTopicEntry,
  cap = CYCLE_LOG_CAP
): NavigatorState {
  return {
    ...nav,
    cycleLog: [...nav.cycleLog, entry].slice(-cap),
    cyclesSinceExplore: entry.mode === 'explore' ? 0 : nav.cyclesSinceExplore + 1,
    // An exploration attempt resets the streak: the bot gets fresh chances to be surprised.
    noSurpriseStreak: entry.surprised || entry.mode === 'explore' ? 0 : nav.noSurpriseStreak + 1,
  };
}

/**
 * A cycle that produced no extraction (idle, failed, timed out) still counts
 * toward the explore cadence, so the explore decision can never freeze.
 */
export function noteCycle(nav: NavigatorState, mode: CycleMode): NavigatorState {
  return { ...nav, cyclesSinceExplore: mode === 'explore' ? 0 : nav.cyclesSinceExplore + 1 };
}

/** Frontier items the bot may pick: open, or already in progress (never stranded). */
const SELECTABLE = new Set(['open', 'exploring']);

export interface FrontierProposal {
  item: FrontierItem;
  crossing: LimitDial[];
}

export interface FrontierSelection {
  item: FrontierItem | null;
  /** `ask`-gated items worth proposing to the operator (best first). */
  proposals: FrontierProposal[];
}

export interface FrontierSelectionOptions {
  /** Penalise items born from the topic the bot is stuck in. */
  avoidTopic?: string | null;
  /** topicId → net operator taste (up + more − down). */
  likedTopics?: Record<string, number>;
}

function score(item: FrontierItem, opts: FrontierSelectionOptions): number {
  let s = item.surpriseScore;
  if (item.operatorSignal === 'up') s += 0.2;
  // In progress (a navigator bet or an unfinished exploration) — keep at it.
  if (item.status === 'exploring') s += 0.1;
  if (opts.avoidTopic && item.fromTopic === opts.avoidTopic) s -= 0.2;
  const taste = item.fromTopic ? (opts.likedTopics?.[item.fromTopic] ?? 0) : 0;
  s += 0.1 * Math.max(-3, Math.min(3, taste));
  return s;
}

export function selectFrontierItem(
  map: KnowledgeMap,
  limits: LimitDials,
  opts: FrontierSelectionOptions = {}
): FrontierSelection {
  const open = map.frontier.filter((f) => SELECTABLE.has(f.status));
  const allowed: FrontierItem[] = [];
  const proposals: FrontierProposal[] = [];
  for (const item of open) {
    const v = evaluateFrontierItem(item, limits);
    if (v.allowed) allowed.push(item);
    else if (
      v.blockedBy.length === 0 &&
      v.needsApproval.length > 0 &&
      item.operatorSignal !== 'down'
    ) {
      proposals.push({ item, crossing: v.needsApproval });
    }
  }
  allowed.sort((a, b) => score(b, opts) - score(a, opts));
  proposals.sort((a, b) => b.item.surpriseScore - a.item.surpriseScore);
  return { item: allowed[0] ?? null, proposals: proposals.slice(0, 3) };
}

/** Frontier block for navigator/strategist prompts. */
export function renderFrontierForPrompt(
  map: KnowledgeMap,
  limits: LimitDials,
  max = 10
): string {
  const open = map.frontier
    .filter((f) => SELECTABLE.has(f.status))
    .sort((a, b) => b.surpriseScore - a.surpriseScore)
    .slice(0, max);
  if (open.length === 0) {
    return '## Frontier\n\n(empty — part of your job is to notice what you do not know yet)';
  }
  const lines = open.map((f) => {
    const v = evaluateFrontierItem(f, limits);
    const tags: string[] = [`distance ${f.distance}`, `surprise ${f.surpriseScore.toFixed(2)}`];
    if (f.status === 'exploring') tags.push('in progress');
    if (f.operatorSignal === 'up') tags.push('operator approved');
    if (v.blockedBy.length > 0) tags.push(`blocked by closed dial: ${v.blockedBy.join(', ')}`);
    else if (v.needsApproval.length > 0)
      tags.push(`needs operator OK: ${v.needsApproval.join(', ')}`);
    return `- [${f.id}] ${f.question} — ${f.whyInteresting} (${tags.join(', ')})`;
  });
  return `## Frontier (open questions worth chasing)\n\n${lines.join('\n')}`;
}

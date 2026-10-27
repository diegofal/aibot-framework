/**
 * The fleet watcher's shared contract (docs/plans/watcher-implementation-plan.md,
 * phase 1). The dashboard page builds against these shapes: add fields, never
 * rename or remove them.
 */
import type { ActivityEvent } from '../bot/activity-stream';
import type { HumanInboundEvent } from '../bot/agent-loop-utils';

/**
 * O10: most member texts one consolidation prompt shows (`consolidate.ts`). A
 * larger cluster is split into chunks of at most this many, each its own call;
 * `consolidate.minCluster` is bounded by it (a larger minimum could never be met).
 */
export const CONSOLIDATE_PROMPT_MEMBERS = 40;

export const NEURON_KINDS = [
  'entity',
  'person',
  'goal',
  'topic',
  'fact',
  'surprise',
  'question',
  'pattern',
  'insight',
  'contradiction',
  'prediction',
  /** O10: what consolidation wrote for a cluster of forgettable facts (`consolidate.ts`). */
  'summary',
] as const;
export type NeuronKind = (typeof NEURON_KINDS)[number];

export const EDGE_RELS = [
  'knows',
  'owned_by',
  'about',
  'related',
  'contradicts',
  'caused',
  'serves',
  'predicts',
] as const;
export type EdgeRel = (typeof EDGE_RELS)[number];

export type Confidence = 'low' | 'medium' | 'high';
export type Vec3 = [number, number, number];
/** `watcher`, or the bot that brought the knowledge (`bot:<id>`). */
export type NeuronCreator = 'watcher' | `bot:${string}`;

export interface NeuronSupport {
  bots: string[];
  cycles?: string[];
  conversations?: string[];
  paths?: string[];
}

/** A unit of information the watcher decided to keep (never a raw event). Embeddings live apart. */
export interface Neuron {
  /** `n-` + 8 hex. */
  id: string;
  kind: NeuronKind;
  text: string;
  support: NeuronSupport;
  createdBy: NeuronCreator;
  createdAt: string;
  lastActivatedAt: string;
  activations: number;
  confidence?: Confidence;
  /** Position inside the unit ball, computed server-side (`layout.ts`). */
  pos?: Vec3;
  archivedAt?: string;
  /** Free attributes. `key` is the stable identity birth and resync dedupe on. */
  meta?: Record<string, string>;
}

export interface Edge {
  /** `e-` + 8 hex. */
  id: string;
  from: string;
  to: string;
  rel: EdgeRel;
  weight: number;
  createdAt: string;
  createdBy: NeuronCreator;
}

export const WATCHER_PHASES = [
  'birth',
  'sense',
  'notice',
  'integrate',
  'broadcast',
  'sleep',
] as const;
export type WatcherPhase = (typeof WATCHER_PHASES)[number];

export interface WatcherLogRow {
  ts: string;
  /** Monotonic across days and restarts. */
  seq: number;
  phase: WatcherPhase;
  op: string;
  /** First-person English written by code, never by an LLM. */
  text: string;
  neuronIds?: string[];
  edgeIds?: string[];
  salience?: number;
  source?: string;
  model?: string;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
  /**
   * Phase 4, `integrate:pass`: the "How I am" variables the model named (known
   * keys only). O3: plus the stakes rules (`stakes.ts`) that shaped the pass, on
   * pass rows of both tiers and on each `stakes:*` row.
   */
  drivenBy?: string[];
  /** O2, `notice:pass` / `integrate:pass`: what woke the pass. */
  trigger?: PassTrigger;
  /** `integrate:insight` / `integrate:no-broadcast`: why the insight calls for no broadcast (model text). */
  whyNoBroadcast?: string;
  /** `integrate:insight`: the insight needed a broadcast or a reason (`insightNeedsBroadcast`) and got neither. */
  broadcastReasonMissing?: true;
  /**
   * O10, `consolidate:preview`: what a consolidation in preview mode would
   * have written (nothing was): the summary, the share of the members it
   * describes, and each member (text clipped) with whether it would be merged.
   */
  consolidatePreview?: {
    summary: string;
    coverage: number;
    members: Array<{ id: string; text: string; merged: boolean }>;
  };
}

/** O2: what woke a notice or integrate pass. */
export type PassTrigger = 'salience' | 'age' | 'agenda-changed' | 'heartbeat' | 'manual';

/** What tier 0 senses: an activity-stream event or a `human_inbound` hook event. */
export type SensedEvent = ActivityEvent | HumanInboundEvent;

export interface BufferItem {
  id: string;
  event: SensedEvent;
  salience: number;
  reasons: string[];
  /** ISO time tier 0 saw the event (metric 2 compares it with the event's own time). */
  noticedAt: string;
  touched: string[];
  /** The operator wrote it (only then may notice keep its words as a fact). */
  fromOperator?: true;
}

/** `partial`: some neurons embedded, then an embedding error stopped the run; start/maintenance continue it. */
export type LinkStatus = 'ok' | 'partial' | 'no-embeddings' | 'pending';

export interface WatcherState {
  running: boolean;
  bornAt?: string;
  phase: WatcherPhase;
  lastTickAt?: string;
  /** When the current run started; absent while asleep. */
  startedAt?: string;
  /** Live neurons per kind. */
  counts: Record<NeuronKind, number>;
  /** O10: archived neurons (forgotten, merged or consolidated); the header shows live / archived. */
  archived?: number;
  edges: number;
  linkStatus: LinkStatus;
  lastError?: string;
  /** Phase 3: neuron ids the last integrate pass said it attends to (`Integrator.attending`). */
  attending?: string[];
  /** When the last integrate pass set `attending`. */
  attendingAt?: string;
  /** Whether the notice and integrate timers are running now (`Watcher.applyConfig`). */
  timers?: { notice: boolean; integrate: boolean };
  /**
   * The live tier switches and daily caps (`tierSwitches`): every state
   * publish carries them, so a change made in one dashboard tab
   * (`POST /api/watcher/config` → `applyConfig`) reaches the others.
   */
  tiers?: Record<'notice' | 'integrate', { enabled: boolean; maxPerDay: number }>;
  /**
   * Autonomy rung 0, C1: the hard kill is on (`src/watcher/kill.ts`): the
   * environment (`AIBOT_WATCHER_KILL`) or the sentinel file
   * (`<paths.data>/watcher-kill`). While killed nothing starts and no call leaves.
   */
  killed?: { source: 'env' | 'file'; since: string };
  /** Autonomy rung 0, C6: USD-equivalent spent this UTC month and the ceiling. */
  month?: { costUsd: number; ceilingUsd: number };
}

export type WatcherEventType =
  | 'watcher:log'
  | 'watcher:neuron'
  | 'watcher:edge'
  | 'watcher:activate'
  | 'watcher:layout'
  | 'watcher:state';

/**
 * What `/ws/watcher` carries: `data` is the row, neuron, edge, activation,
 * state, or for `watcher:layout` `{ positions: { [neuronId]: [x, y, z] } }`.
 */
export interface WatcherEvent {
  type: WatcherEventType;
  ts: string;
  data: unknown;
}

export interface ActivationData {
  id: string;
  activations: number;
  lastActivatedAt: string;
}

export const BIRTH_STAGES = [
  'wake',
  'fleet',
  'people',
  'goals',
  'knowledge',
  'memory',
  'history',
  'link',
  'done',
] as const;
export type BirthStage = (typeof BIRTH_STAGES)[number];

/** `<data>/watcher/birth.json`, written after every stage so a restart resumes. */
export interface BirthRecord {
  stage: BirthStage;
  done: BirthStage[];
  startedAt: string;
  finishedAt?: string;
  counts: Partial<Record<NeuronKind, number>> & { edges?: number };
  unreadable: string[];
  linkStatus?: LinkStatus;
}

export interface WatcherConfig {
  enabled: boolean;
  notice: {
    enabled: boolean;
    backend: 'claude-cli' | 'ollama';
    model: string;
    /** Deprecated (O2): unused, kept so live configs validate. */
    everyMs: number;
    salienceBar: number;
    maxPerDay: number;
    /** A pass wakes when the salient items waiting add up to this. */
    wakeSalience: number;
    /** ...or when the oldest salient item has waited this long. */
    maxWaitMs: number;
  };
  integrate: {
    enabled: boolean;
    model: string;
    /** Deprecated (O2): `wakeSalience` decides. */
    salienceBar: number;
    heartbeatMs: number;
    /** The heartbeat runs a pass only with at least this many salient items pending. */
    minItems: number;
    /** Cross-bot related pairs (and waiting insights) the "Standing agenda" shows. */
    agendaMax: number;
    /** Deprecated (O2): an agenda pass runs when the agenda changes. */
    agendaEveryMs: number;
    /** An agenda-only pass runs at most once per this long, whatever the agenda gained. */
    agendaFloorMs: number;
    maxPerDay: number;
    maxTokensPerDay: number;
    /** A pass wakes when the salience pending since the last one adds up to this. */
    wakeSalience: number;
  };
  graph: {
    /** Deprecated (O10): forgetting is by importance (`forget`); kept so live configs validate. */
    archiveAfterDays: number;
    relatedThreshold: number;
    /** Hard ceiling: past it, the oldest inactive neuron is archived at once. */
    maxNeurons: number;
    /** O10: above this size daily forgetting archives low-importance neurons past `forget.maxPerRun` until the live graph is this size. */
    targetNeurons?: number;
  };
  birth: { historyDays: number };
  log: { senseSummaryEveryMs: number };
  /** O1 fast lane (`src/watcher/fast-lane.ts`); absent = `WATCHER_DEFAULTS.fastLane`. */
  fastLane?: { enabled: boolean; minBots: number; maxPerDay: number };
  /** Self-improvement loop (`src/watcher/self-improve.ts`); absent = `WATCHER_DEFAULTS.selfImprove`. */
  selfImprove?: { enabled: boolean; toolProblemBots: number; everyHours: number };
  /** O10 forgetting (`importance.ts`); absent = `WATCHER_DEFAULTS.forget`. */
  forget?: {
    threshold: number;
    graceDays: number;
    /** Most neurons one daily run archives below the target; absent = 200. */
    maxPerRun?: number;
  };
  /** O10 nightly consolidation (`consolidate.ts`); absent = `WATCHER_DEFAULTS.consolidate`. */
  consolidate?: {
    enabled: boolean;
    /** Call and validate, log `consolidate:preview`, write nothing; absent = true. */
    preview?: boolean;
    hour: number;
    minCluster: number;
    maxClusters: number;
    minCoverage?: number;
  };
  /** Autonomy rung 0: the operator's controls (`src/watcher/autonomy/`); absent = `WATCHER_DEFAULTS.autonomy`. */
  autonomy?: {
    monthlyCeilingUsd: number;
    proposals: { enabled: boolean; maxPending: number; approvalTtlHours: number };
    /** Rung 2: the weekly fleet cost audit (`autonomy/self-study.ts`); absent = defaults (off). */
    selfStudy?: { enabled: boolean; everyHours: number; firstRunDelayMinutes: number };
  };
}

/** Mirrors `WatcherConfigSchema` in `src/config.ts` (tests/watcher/types.test.ts keeps them equal). */
export const WATCHER_DEFAULTS: WatcherConfig = {
  enabled: false,
  notice: {
    enabled: false,
    backend: 'claude-cli',
    model: 'claude-haiku-5-5',
    everyMs: 300_000,
    salienceBar: 0.4,
    maxPerDay: 288,
    wakeSalience: 1.0,
    maxWaitMs: 1_800_000,
  },
  integrate: {
    enabled: false,
    model: 'claude-opus-5-5',
    salienceBar: 2.0,
    heartbeatMs: 3_600_000,
    minItems: 5,
    agendaMax: 8,
    agendaEveryMs: 21_600_000,
    agendaFloorMs: 7_200_000,
    maxPerDay: 24,
    maxTokensPerDay: 600_000,
    wakeSalience: 3.0,
  },
  graph: { archiveAfterDays: 30, relatedThreshold: 0.82, maxNeurons: 20_000, targetNeurons: 8000 },
  birth: { historyDays: 30 },
  log: { senseSummaryEveryMs: 60_000 },
  fastLane: { enabled: true, minBots: 2, maxPerDay: 6 },
  selfImprove: { enabled: true, toolProblemBots: 3, everyHours: 24 },
  forget: { threshold: 0.15, graceDays: 7, maxPerRun: 200 },
  consolidate: {
    enabled: false,
    preview: true,
    hour: 4,
    minCluster: 6,
    maxClusters: 10,
    minCoverage: 0.5,
  },
  autonomy: {
    monthlyCeilingUsd: 90,
    proposals: { enabled: false, maxPending: 3, approvalTtlHours: 72 },
    selfStudy: { enabled: false, everyHours: 168, firstRunDelayMinutes: 30 },
  },
};

export function emptyCounts(): Record<NeuronKind, number> {
  return Object.fromEntries(NEURON_KINDS.map((k) => [k, 0])) as Record<NeuronKind, number>;
}

export function isHumanInbound(event: SensedEvent): event is HumanInboundEvent {
  return typeof (event as HumanInboundEvent).channelKind === 'string' && !('type' in event);
}

/**
 * `Neuron.meta` key set to `'true'` when operator material is part of what
 * supports the neuron, directly (notice) or through what an insight stands on
 * (integrate). Operator material is an operator message AND every bot-activity
 * event (cycles, tools, surprises, workers, goals, tasks): what the operator's
 * bots work on is the operator's. `fleet_memory_search` shows such neurons only
 * to the operator.
 */
export const OPERATOR_SOURCED = 'operatorSourced';

/**
 * `Neuron.meta` key set to `'true'` when an operator message (a buffer item
 * `fromOperator`) is among the items behind the neuron, at creation or at a
 * later recognition. Narrower than `OPERATOR_SOURCED`: the neuron's text may be
 * the operator's own words, so the fast lane never quotes it to a bot. Notice
 * writes `'false'` explicitly at creation; a neuron without the key predates
 * it, and the fast lane treats an operator-sourced one as `'true'`.
 */
export const OPERATOR_MESSAGE = 'operatorMessage';

/** A buffer item that is a non-operator human message (already reduced to topic words by tier 0). */
export function isPublicHumanItem(item: Pick<BufferItem, 'event' | 'fromOperator'>): boolean {
  return isHumanInbound(item.event) && item.fromOperator !== true;
}

/**
 * Operator-sourced unless every item is a non-operator human message (public
 * content is only topic words, and it is the caller's own channel). No items
 * at all is operator-sourced too: conservative.
 */
export function restsOnOperatorMaterial(
  items: ReadonlyArray<Pick<BufferItem, 'event' | 'fromOperator'>>
): boolean {
  return items.length === 0 || items.some((i) => !isPublicHumanItem(i));
}

export function isOperatorSourced(n: Pick<Neuron, 'meta'>): boolean {
  return n.meta?.[OPERATOR_SOURCED] === 'true';
}

/**
 * Whether a neuron may carry an operator message's words: `operatorMessage`
 * `'true'`, or operator-sourced and either without the flag (it predates it)
 * or not a pattern (a fact may be their words). A notice pass shown such a
 * neuron marks what it writes `operatorMessage: 'true'`.
 */
export function mayCarryOperatorMessage(n: Pick<Neuron, 'kind' | 'meta'>): boolean {
  const flag = n.meta?.[OPERATOR_MESSAGE];
  if (flag === 'true') return true;
  return isOperatorSourced(n) && (flag === undefined || n.kind !== 'pattern');
}

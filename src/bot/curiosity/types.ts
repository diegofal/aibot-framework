/**
 * Curiosity DNA — shared types.
 *
 * Every bot carries six genes (curious, compounding, self-directed,
 * captivating, honest, bold). The data below is what makes them mechanical
 * rather than prompt slogans: a knowledge map that compounds, a frontier of
 * candidate directions ranked by expected surprise, a navigator that owns
 * direction above the strategist, and dispatches — the insight the operator
 * actually receives. See docs/plans/curiosity-navigator-plan.md.
 *
 * All of it lives in the bot's soul dir (so it travels with the export):
 *   KNOWLEDGE.json  — KnowledgeMap
 *   NAVIGATOR.json  — NavigatorState
 *   TASTE.json      — TasteProfile
 *   DISPATCHES.jsonl — one Dispatch per line
 */

// ── Limit dials ─────────────────────────────────────────────────────────

/** closed = stays inside; ask = proposes crossing to the operator; open = crosses and reports. */
export type DialLevel = 'closed' | 'ask' | 'open';

export const LIMIT_DIALS = [
  'topic',
  'purpose',
  'instructions',
  'method',
  'capability',
  'identity',
] as const;
export type LimitDial = (typeof LIMIT_DIALS)[number];
export type LimitDials = Record<LimitDial, DialLevel>;

export const CURIOSITY_PRESET_IDS = ['focused', 'explorer', 'wild'] as const;
export type CuriosityPresetId = (typeof CURIOSITY_PRESET_IDS)[number];

export interface DispatchSettings {
  enabled: boolean;
  /** Hard cap on the dispatch body the operator receives. */
  maxChars: number;
  /** Editor score (0–1) a dispatch needs to be sent instead of held. */
  minEditorScore: number;
  /** Starting gap between dispatches; earned down / decayed up by operator signals. */
  baseIntervalHours: number;
  minIntervalHours: number;
  maxIntervalHours: number;
}

/** Fully-resolved curiosity settings for one bot (global → preset → per-bot → trait). */
export interface ResolvedCuriosity {
  enabled: boolean;
  preset: CuriosityPresetId;
  limits: LimitDials;
  /** Effective share of exploration cycles after the curiosity trait scaled it. */
  exploreRatio: number;
  /** Topic-concentration trigger over the last `topicWindow` cycles. */
  maxTopicShare: number;
  topicWindow: number;
  /** A directive is served after this many outputs answered it… */
  directiveHalfLifeOutputs: number;
  /** …or after this many days, whichever first. */
  directiveHalfLifeDays: number;
  navigatorEveryMs: number;
  /** Cycles in a row with nothing surprising before an exploration is forced. */
  noSurpriseStreak: number;
  dispatch: DispatchSettings;
}

// ── Knowledge map ───────────────────────────────────────────────────────

export type Confidence = 'low' | 'medium' | 'high';

export interface Finding {
  id: string;
  claim: string;
  /** Where the claim is backed: a production path, a URL, a tool result. */
  evidence?: string;
  confidence: Confidence;
  at: string;
}

export interface Surprise {
  id: string;
  text: string;
  at: string;
}

export interface KnowledgeTopic {
  /** Stable slug derived from the name. */
  id: string;
  name: string;
  /** 0 = touched, 1 = working knowledge, 2 = solid, 3 = expert. */
  depth: number;
  firstSeen: string;
  lastTouched: string;
  cycles: number;
  findings: Finding[];
  surprises: Surprise[];
  openQuestions: string[];
  /** Productions / artifacts that back this topic. */
  outputs: string[];
}

export type FrontierStatus = 'open' | 'exploring' | 'explored' | 'dropped';

export interface FrontierItem {
  id: string;
  question: string;
  /** Why the answer could surprise — the curiosity pitch. */
  whyInteresting: string;
  /** One sentence tying it back to the bot's purpose. Absent = crosses the purpose dial. */
  bridge?: string;
  /** Hops from the core topics: 0 core, 1 adjacent, 2+ far. */
  distance: number;
  /** Expected surprise / information gain, 0–1. */
  surpriseScore: number;
  fromTopic?: string;
  createdAt: string;
  status: FrontierStatus;
  /** Operator verdict: 'up' approves an `ask`-gated item, 'down' drops it. */
  operatorSignal?: 'up' | 'down';
  exploredAt?: string;
}

export interface KnowledgeMap {
  version: 1;
  topics: KnowledgeTopic[];
  frontier: FrontierItem[];
  /** Interests the bot grew into (only used when the identity dial allows it). */
  interests: string[];
  updatedAt: string | null;
}

// ── Navigator ───────────────────────────────────────────────────────────

export type DirectiveSource = 'ask_human' | 'feedback' | 'message';

export interface Directive {
  id: string;
  text: string;
  source: DirectiveSource;
  receivedAt: string;
  /** Outputs that answered it so far. */
  servedOutputs: number;
  status: 'active' | 'served';
  servedAt?: string;
}

export type CycleMode = 'explore' | 'exploit';

export interface DirectionBet {
  id: string;
  title: string;
  kind: CycleMode;
  rationale: string;
  frontierId?: string;
  topic?: string;
}

export interface Direction {
  at: string;
  /** One-paragraph "where I'm going and why". */
  summary: string;
  retrospective: string;
  bets: DirectionBet[];
  /** Operator verdict on this direction. */
  operatorSignal?: 'up' | 'down';
}

export interface CycleTopicEntry {
  at: string;
  topic: string;
  mode: CycleMode;
  surprised: boolean;
  frontierId?: string;
}

export interface NavigatorState {
  version: 1;
  lastNavigatorAt: string | null;
  /** Last attempt, successful or not — failures back off instead of retrying every cycle. */
  lastNavigatorAttemptAt?: string | null;
  /** Identity-dial `ask` interests the navigator wants to propose (consumed by the dispatch step). */
  pendingInterests?: string[];
  direction: Direction | null;
  directives: Directive[];
  /** Last cycles, newest last (capped). */
  cycleLog: CycleTopicEntry[];
  cyclesSinceExplore: number;
  noSurpriseStreak: number;
}

// ── Dispatch + taste ────────────────────────────────────────────────────

export type DispatchKind = 'insight' | 'proposal' | 'digest';
export type DispatchStatus = 'sent' | 'held' | 'dropped';
export type DispatchSignal = 'up' | 'down' | 'more';

export interface Dispatch {
  id: string;
  botId: string;
  createdAt: string;
  kind: DispatchKind;
  topic: string;
  /** One non-obvious claim, first. */
  hook: string;
  whyCare: string;
  evidence: string;
  action: string;
  question?: string;
  /** Rendered text actually delivered. */
  body: string;
  editorScore: number;
  editorNotes?: string;
  status: DispatchStatus;
  sentAt?: string;
  signal?: DispatchSignal;
  signalAt?: string;
  /** Dials this proposal asks permission to cross. */
  crossing?: LimitDial[];
  frontierId?: string;
  /** Set once an unanswered sent dispatch has been counted against the cadence. */
  ignoredCounted?: boolean;
  /** Identity proposals: the interest adopted when the operator approves. */
  interest?: string;
  /** Where a sent dispatch went: a Telegram ping, or only the dashboard feed. */
  deliveredVia?: 'telegram' | 'inbox';
}

export interface DispatchCadence {
  intervalHours: number;
  lastSentAt: string | null;
}

export interface TasteCounts {
  up: number;
  down: number;
  more: number;
}

export interface TasteProfile {
  version: 1;
  topics: Record<string, TasteCounts>;
  kinds: Record<string, TasteCounts>;
  /** Hooks the operator liked / disliked, newest last (capped). */
  likedHooks: string[];
  dislikedHooks: string[];
  cadence: DispatchCadence;
  updatedAt: string | null;
}

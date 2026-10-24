import type { TraitChangeRecord } from '../why/builders/trait-change';
/**
 * Stats & Behaviour dashboard — API contract types.
 *
 * These shapes are frozen: the dashboard frontend (web/pages/stats.js) is
 * built against them. Add fields if you must, never rename or remove.
 */
import type { Why } from '../why/types';

export type StatsWindow = '24h' | '7d' | '30d';

export type ChannelKind = 'telegram' | 'headless';
export type ChannelState =
  | 'ok'
  | 'revoked'
  | 'placeholder'
  | 'missing'
  | 'error'
  | 'configured'
  | 'unknown';

/** Snapshot of the agent-loop backend circuit breaker for one backend. */
export interface BackendCircuitSnapshot {
  open: boolean;
  halfOpen: boolean;
  until: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}
export type Posture = 'active' | 'standby' | 'dormant' | 'blocked' | 'idle' | 'unknown';

/** What `computePosture` decides on (`src/stats/posture.ts`). */
export interface PostureInput {
  enabled: boolean;
  nowMs: number;
  lastRunAt: number | null;
  retryCount: number;
  lastError: string | null;
  consecutiveIdleCycles: number;
  goalsActive: number;
  goalsByStatus: Record<string, number>;
  lastOutcomeAt: number | null;
}

/** The posture rule that fired, first match wins (`computePostureWithRule`). */
export type PostureRule =
  | 'disabled'
  | 'never-ran'
  | 'retries'
  | 'all-goals-blocked'
  | 'no-goals'
  | 'idle-streak'
  | 'stale-run'
  | 'no-recent-outcome'
  | 'active';

/** A posture with the rule that produced it and what it decided on; `postureToWhy` explains it. */
export interface PostureVerdict {
  posture: Posture;
  rule: PostureRule;
  inputs: PostureInput;
}

export interface LlmStats {
  calls: number;
  failed: number;
  failRate: number;
  avgDurationMs: number;
  promptTokens: number;
  completionTokens: number;
  byCaller: Record<string, { calls: number; failed: number }>;
  byModel: Record<string, { calls: number; promptTokens: number; completionTokens: number }>;
  lastError: string | null;
  lastCallAt: string | null;
}

export interface ToolStats {
  calls: number;
  failed: number;
  failRate: number;
  top: Array<{ name: string; count: number; failed: number }>;
  loopBreaks: number;
  /** Failed calls a third party refused (bot wall, 403, 429). Not in `failed`. */
  blocked: number;
  /** Commands that ran to completion and exited non-zero. Not in `failed`. */
  exitNonzero: number;
  /** Failures on a target that does not exist (404/410). Included in `failed`. */
  notFound: number;
  /** Failures our own guardrails refused (SSRF guard, throttle). Included in `failed`. */
  policy: number;
}

export interface OutputStats {
  filesActive: number;
  filesArchived: number;
  approved: number;
  rejected: number;
  /** Files waiting on a first review (same definition as Needs You). */
  unreviewed: number;
  /** Files reviewed before that the bot edited since; not in `unreviewed`. */
  editedSinceReview: number;
  outcomesProduced: number;
  outcomesStale: number;
  lastFileAt: string | null;
}

export interface EngagementStats {
  asksSent: number;
  asksAnswered: number;
  asksPending: number;
  asksClosedUnanswered: number;
  messagesSentProactive: number;
  collaborateCalls: number;
  collaborateFailed: number;
  meshPublished: number;
}

export interface GoalsStats {
  active: number;
  completed: number;
  byStatus: Record<string, number>;
  archivedInActive: number;
  duplicates: number;
  oversizedNotes: number;
  lastCompletedAt: string | null;
}

export interface KarmaStats {
  score: number | null;
  delta: number;
  events: number;
}

/** One trait change on Agent Home (`readTraitChanges` + `traitChangeToWhy`). */
export interface TraitChange extends TraitChangeRecord {
  why: Why;
}

export interface TraitStats {
  current: Record<string, number> | null;
  baseline: Record<string, number> | null;
  drift: Record<string, number> | null;
  adjustments: number;
}

export interface SoulStats {
  lastReflectionAt: string | null;
  lastHealthCheckAt: string | null;
  memoryBytes: number;
  goalsBytes: number;
  dailyLogsPending: number;
  soulEqualsMotivations: boolean;
  missingFiles: string[];
}

export interface CycleStats {
  total: number;
  idle: number;
  avgDurationMs: number;
  alignmentWarnings: number;
}

export interface LoopStats {
  cadence: string | null;
  mode: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  consecutiveIdleCycles: number;
  retryCount: number;
  lastError: string | null;
}

export interface FleetBotStats {
  botId: string;
  name: string;
  enabled: boolean;
  backend: 'ollama' | 'claude-cli' | null;
  model: string | null;
  channel: { kind: ChannelKind; state: ChannelState };
  loop: LoopStats;
  posture: Posture;
  /** The rule behind `posture` and what it decided on (`postureToWhy` explains it). */
  postureVerdict: PostureVerdict;
  lastHumanContactAt: string | null;
  llm: LlmStats;
  tools: ToolStats;
  output: OutputStats;
  engagement: EngagementStats;
  goals: GoalsStats;
  karma: KarmaStats;
  traits: TraitStats;
  soul: SoulStats;
  cycles: CycleStats;
}

export interface FleetTotals {
  llmCalls: number;
  llmFailed: number;
  toolCalls: number;
  toolFailed: number;
  /** Sum of `ToolStats.blocked`: calls refused by third parties, not in `toolFailed`. */
  toolBlocked: number;
  /** Sum of `ToolStats.exitNonzero`: non-zero command exits, not in `toolFailed`. */
  toolExitNonzero: number;
  promptTokens: number;
  completionTokens: number;
  filesActive: number;
  unreviewed: number;
  asksPending: number;
  cycles: number;
}

export interface FleetResponse {
  generatedAt: string;
  window: StatsWindow;
  bots: FleetBotStats[];
  totals: FleetTotals;
}

/** One task of a goal as the boards read it (`status` and `done` kept for older UI code). */
export interface GoalTaskView {
  id: string;
  text: string;
  lane: 'todo' | 'in_progress' | 'blocked' | 'done';
  /** Same as `lane`. */
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  /** `lane === 'done'`. */
  done: boolean;
  by: 'operator' | 'agent';
  note: string | null;
  /** The cycle that created the task. */
  cycleId: string | null;
  /** A live worker claim on the task. */
  claim?: { runId: string };
}

export interface GoalDetail {
  /** Stable goal id (`id:` line in GOALS.md), null on goals written before ids existed. */
  id: string | null;
  text: string;
  status: string;
  priority: string;
  /** Full notes text (null when there are none) — the dashboard previews it, truncated client-side. */
  notes: string | null;
  notesLength: number;
  completed: string | null;
  outcome: string | null;
  source: string | null;
  section: 'active' | 'completed';
  /** Tasks in order, from the task store (TASKS.json); empty when there are none. */
  tasks: GoalTaskView[];
  /** Short card title set on the board; null = the board derives one from `text`. */
  headline: string | null;
  /** Id of the goal this one was made from (`- parent:`), null when none. */
  parent: string | null;
  /** `standing`: no end state, so no tasks (`- kind: standing`); null = a project. Additive. */
  kind?: 'standing' | null;
  /** Why a completed goal was dropped as no longer applying (`- dropped:`); null = not dropped. Additive. */
  dropped?: string | null;
}

export interface TraitSnapshot {
  timestamp: number;
  source: string;
  traits: Record<string, number>;
}

export interface RecentCycle {
  cycle: number;
  timestamp: number;
  tools: string[];
  planSummary: string;
}

export interface AskDetail {
  id: string;
  title: string;
  createdAt: string;
  inboxStatus: string | null;
  questionChars: number;
  answeredAt: string | null;
  /** Agent-loop cycle / goal the question was asked from, when recorded. */
  cycleId?: string;
  goalId?: string;
}

export interface BotDetailResponse extends FleetBotStats {
  window: StatsWindow;
  generatedAt: string;
  goalsDetail: GoalDetail[];
  traitHistory: TraitSnapshot[];
  recentCycles: { actions: RecentCycle[]; lastLoggedSummary: string | null };
  llmDaily: Array<{ date: string; calls: number; failed: number; promptTokens: number }>;
  toolsDaily: Array<{ date: string; calls: number; failed: number }>;
  asks: AskDetail[];
  topErrors: Array<{ message: string; count: number }>;
}

export type AskBucket = '<300' | '300-600' | '600-1200' | '>1200';

export interface BehaviourResponse {
  generatedAt: string;
  window: StatsWindow;
  productionWithoutFeedback: Array<{
    botId: string;
    outputsSinceFeedback: number;
    lastFeedbackAt: string | null;
  }>;
  askEconomics: {
    buckets: Array<{
      bucket: AskBucket;
      sent: number;
      answered: number;
      medianTimeToAnswerMs: number | null;
    }>;
  };
  collaboration: {
    nodes: Array<{ botId: string }>;
    edges: Array<{ from: string; to: string; calls: number; failed: number }>;
  };
  mesh: { byBot: Record<string, number>; total: number };
  traitVariance: Array<{ timestamp: number; variance: Record<string, number> }>;
  fleetDriftVector: Record<string, number>;
}

export interface InfraResponse {
  generatedAt: string;
  backends: Array<{
    name: string;
    last429At: string | null;
    last401At: string | null;
    lastErrorMessage: string | null;
    failedCalls24h: number;
    /** Live circuit-breaker state from the agent loop; null when not exposed. */
    circuit: BackendCircuitSnapshot | null;
    /** `ollama` only, when the route has a probe: the embedding service (`stats/embedding-probe.ts`). */
    embedding?: import('./embedding-probe').EmbeddingHealth;
  }>;
  securityAudit: Array<{ botId: string; critical: number; warn: number; info: number; at: string }>;
  cron: Array<{
    id: string;
    name: string;
    botId: string | null;
    schedule: string;
    enabled: boolean;
    lastStatus: string | null;
    lastError: string | null;
    lastRunAt: string | null;
    nextRunAt: string | null;
    consecutiveErrors: number;
  }>;
  telegram: Array<{ botId: string; state: ChannelState; lastError: string | null }>;
  logNoise: Array<{ msg: string; level: number; count: number }>;
  boots: string[];
  logBytes: number;
}

// ── Curiosity (GET /api/stats/curiosity) ──

/** How a sent dispatch landed: 👍, "more", 👎, no signal after 48 h on Telegram, or still open. */
export type DispatchLanding = 'up' | 'more' | 'down' | 'ignored' | 'pending';

export interface CuriosityDiversityPoint {
  at: string;
  topic: string;
  mode: 'explore' | 'exploit';
  surprised: boolean;
  /** Distinct topics in the trailing `topicWindow` cycles ending here. */
  distinctTopics: number;
  /** Share of the most frequent topic in that trailing window (0–1). */
  dominantShare: number;
}

export interface CuriosityDailyMix {
  date: string;
  cycles: number;
  explore: number;
  exploit: number;
  surprised: number;
  distinctTopics: number;
}

export interface DispatchLandingStats {
  sent: number;
  up: number;
  more: number;
  down: number;
  ignored: number;
  pending: number;
  /** (up + more) / resolved, where resolved = up + more + down + ignored; null with nothing resolved. */
  landingRate: number | null;
  held: number;
  dropped: number;
  /** Median editor score over every dispatch in the window, any status. */
  medianEditorScore: number | null;
}

export interface CuriosityBotStats {
  botId: string;
  name: string;
  curiosityEnabled: boolean;
  topicWindow: number;
  knowledge: {
    topics: number;
    findings: number;
    surprises: number;
    openQuestions: number;
    interests: number;
    frontier: Record<string, number>;
    topTopics: Array<{ name: string; depth: number; cycles: number }>;
    updatedAt: string | null;
  };
  cycles: {
    total: number;
    explore: number;
    exploit: number;
    surprised: number;
    exploreShare: number | null;
    distinctTopics: number;
    dominantTopic: string | null;
    dominantShare: number | null;
    /** Oldest cycle still in the capped cycle log (history before it is gone). */
    historyStart: string | null;
  };
  diversity: CuriosityDiversityPoint[];
  daily: CuriosityDailyMix[];
  direction: {
    at: string;
    summary: string;
    bets: Array<{ title: string; kind: 'explore' | 'exploit' }>;
  } | null;
  lastNavigatorAt: string | null;
  cadenceHours: number | null;
  dispatches: DispatchLandingStats;
}

export interface CuriosityStatsResponse {
  generatedAt: string;
  window: StatsWindow;
  /** Cycle log entries kept per bot (`CYCLE_LOG_CAP`). */
  cycleLogCap: number;
  ignoredAfterHours: number;
  bots: CuriosityBotStats[];
  fleet: {
    cycles: number;
    explore: number;
    exploit: number;
    dispatches: DispatchLandingStats;
  };
}

// ── Goal detail (Agent Home → goal sidebar) ──

/** How a cycle was tied to a goal: recorded ids, a strong signal, or shared words. */
export type GoalAttribution = 'exact' | 'inferred' | 'weak';
export type GoalOrigin =
  | 'operator'
  | 'agent'
  | 'strategist'
  | 'reflection'
  | 'curiosity'
  | 'preset'
  | 'unknown';

export interface GoalDetailHeader {
  id: string | null;
  text: string;
  status: string;
  section: 'active' | 'completed';
  bucket: 'todo' | 'inProgress' | 'blocked' | 'done';
  priority: string;
  notes: string | null;
  outcome: string | null;
  source: string | null;
  origin: GoalOrigin;
  originDate: string | null;
  created: string | null;
  started: string | null;
  updated: string | null;
  completed: string | null;
}

export interface GoalTimelineEvent {
  ts: string;
  op: string;
  from: string | null;
  to: string | null;
  actor: string | null;
  note: string | null;
  /** True when reconstructed (from a manage_goals call), not read from the goal-event log. */
  inferred: boolean;
  source: 'goal-events' | 'tool-audit';
  /** The agent-loop cycle the change happened in, when recorded. */
  cycleId: string | null;
  /** The reason its writer recorded with the change (strategist, navigator, lint, …). */
  reason: string | null;
  /** Hygiene run that made the change (goal-lint), or the worker run of a task op. */
  runId: string | null;
  /** Task-store rows (`task-*` ops): the task's text at the time. */
  task?: string | null;
  /** Task-store rows: the task id. */
  taskId?: string | null;
  /** "Why this?" for the change (`goalEventToWhy`; task rows `taskEventToWhy`). */
  why: Why;
}

export interface GoalCycleLlmCall {
  ts: string;
  caller: string;
  backend: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  ok: boolean;
  error: string | null;
}

export interface GoalCycleToolCall {
  ts: string;
  name: string;
  ok: boolean;
  failureKind: string | null;
  args: string;
  result: string;
}

export interface GoalCycleProduction {
  ts: string;
  path: string;
  action: string;
  size: number;
  description: string;
  /** This row's verdict; `pending` when it is the file's latest unreviewed content row; null when superseded or not content. */
  review: 'approved' | 'rejected' | 'pending' | null;
}

export interface GoalCycleAsk {
  id: string;
  title: string;
  createdAt: string;
  status: string | null;
}

export interface GoalCycleKarma {
  ts: string;
  delta: number;
  reason: string;
  kind: string | null;
}

export interface GoalCycle {
  cycleId: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: string | null;
  focus: string | null;
  planSummary: string | null;
  attribution: GoalAttribution;
  reason: string;
  llmCalls: GoalCycleLlmCall[];
  toolCalls: GoalCycleToolCall[];
  productions: GoalCycleProduction[];
  asks: GoalCycleAsk[];
  karma: GoalCycleKarma[];
}

/** One agent-loop cycle on its own (`GET /api/agents/:id/cycles/:cycleId`, the "Open cycle" sheet). */
export interface CycleDetailResponse {
  botId: string;
  generatedAt: string;
  cycle: GoalCycle;
  /** The goal the cycle served, when it recorded one. */
  goal: { id: string | null; title: string } | null;
  /**
   * Why an idle/skipped/error cycle went that way, as the cycle log recorded
   * it (plain words; source: Planner, Engagement gate, Circuit breaker, Error,
   * System). Null on completed cycles and rows written before it was kept.
   */
  cycleReason: { text: string; source: string } | null;
  /** Whether the strategist ran; null when the row predates the field. */
  strategistRan: boolean | null;
  /** Strategist reflection (capped 600 chars), when it ran. */
  reflection: string | null;
  /** Trait deltas the strategist applied in the cycle. */
  traitAdjustments: Record<string, number> | null;
}

export interface GoalDetailResponse {
  botId: string;
  generatedAt: string;
  /** Lookback in days (1–30). */
  days: number;
  goal: GoalDetailHeader;
  timeline: GoalTimelineEvent[];
  /** Newest first, at most `GOAL_DETAIL_MAX_CYCLES`. */
  cycles: GoalCycle[];
  totals: {
    cycles: number;
    exactCycles: number;
    inferredCycles: number;
    llmCalls: number;
    tokens: number;
    toolCalls: number;
    toolFailures: number;
    files: number;
    asks: number;
  };
  tracking: {
    /** Whether any exact (id-linked) data exists for this goal. */
    exact: boolean;
    note: string;
  };
}

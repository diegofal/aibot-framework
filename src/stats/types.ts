/**
 * Stats & Behaviour dashboard — API contract types.
 *
 * These shapes are frozen: the dashboard frontend (web/pages/stats.js) is
 * built against them. Add fields if you must, never rename or remove.
 */

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

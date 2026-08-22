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
}

export interface OutputStats {
  filesActive: number;
  filesArchived: number;
  approved: number;
  rejected: number;
  unreviewed: number;
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

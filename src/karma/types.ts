export type KarmaSource =
  | 'production'
  | 'agent-loop'
  | 'feedback'
  | 'goal'
  | 'manual'
  | 'tool'
  | 'engagement';

/**
 * Outcome kinds the framework can credit or debit. The delta for each kind is
 * looked up in `config.karma.rewards` — a kind worth 0 is never written.
 */
export interface KarmaRewards {
  /** A non-idle agent-loop cycle whose plan was not a repeat (activity, not impact — 0 by default) */
  novelAction: number;
  /** Operator approved a production */
  productionApproved: number;
  /** Operator rejected a production */
  productionRejected: number;
  /** A human answered an ask_human question */
  askAnswered: number;
  /** A human replied to the bot in a conversation (rate-limited per bot) */
  humanReply: number;
  /** A bot-to-bot collaboration finished */
  collaborateCompleted: number;
  /** A tool call failed (execution/validation) */
  toolError: number;
}

export type KarmaOutcomeKind = keyof KarmaRewards;

export const DEFAULT_KARMA_REWARDS: KarmaRewards = {
  novelAction: 0,
  productionApproved: 3,
  productionRejected: -1,
  askAnswered: 2,
  humanReply: 3,
  collaborateCompleted: 0,
  toolError: -1,
};

/** Which ledger source each outcome kind is filed under */
export const KARMA_KIND_SOURCE: Record<KarmaOutcomeKind, KarmaSource> = {
  novelAction: 'agent-loop',
  productionApproved: 'production',
  productionRejected: 'production',
  askAnswered: 'engagement',
  humanReply: 'engagement',
  collaborateCompleted: 'agent-loop',
  toolError: 'tool',
};

export interface KarmaEvent {
  id: string;
  botId: string;
  timestamp: string;
  delta: number;
  reason: string;
  source: KarmaSource;
  /** Outcome kind when the event came through `recordOutcome` */
  kind?: KarmaOutcomeKind;
  metadata?: Record<string, unknown>;
}

/** Raw (undecayed) delta sums over a trailing window — what the score is made of */
export interface KarmaBreakdown {
  windowDays: number;
  bySource: Partial<Record<KarmaSource, number>>;
  byKind: Partial<Record<KarmaOutcomeKind, number>>;
}

export interface KarmaScore {
  botId: string;
  current: number;
  trend: 'rising' | 'falling' | 'stable';
  recentEvents: KarmaEvent[];
  breakdown: KarmaBreakdown;
}

export type KarmaTrend = KarmaScore['trend'];

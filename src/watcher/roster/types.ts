/**
 * The mind-proposed roster (plan: `docs/plans/mind-roster-plan.md`): the
 * operator's brief, the designer's answer, and what the routes return. Add
 * fields, never rename: `brief.json` and `roster.json` live in the watcher dir.
 */

/** The `agentProposals` author of every proposal the mind makes. */
export const WATCHER_PROPOSER = '__watcher__';

export const BRIEF_MAX_WANTS = 5;
export const BRIEF_WHAT_MAX = 300;
export const BRIEF_SHORT_MAX = 80;
export const BRIEF_SUCCESS_MAX = 300;
export const BRIEF_NOTES_MAX = 2000;

/** One thing the operator wants, in his words. */
export interface BriefWant {
  /** `w-` + 6 hex, stable across edits. */
  id: string;
  what: string;
  /** How often ("every Monday", "daily"). */
  cadence: string;
  /** How he wants to receive it ("Telegram", "dashboard"). */
  delivery: string;
  /** What a good result looks like. */
  success: string;
}

export interface OperatorBrief {
  wants: BriefWant[];
  notes: string;
  /** ISO; absent on a brief never saved. */
  updatedAt?: string;
}

export interface RosterSettings {
  enabled: boolean;
  everyHours: number;
  maxProposals: number;
  maxPending: number;
}

export const ROSTER_DEFAULTS: RosterSettings = {
  enabled: true,
  everyHours: 168,
  maxProposals: 2,
  maxPending: 2,
};

/** One bot the designer proposed, as parsed (before vetting). */
export interface DesignedBot {
  agentId: string;
  name: string;
  emoji?: string;
  role: string;
  personality: string;
  /** Want ids from the brief. */
  serves: string[];
  mindObjective?: string;
  deliverable: string;
  /** `agentLoop.every` (`30m`–`7d`). */
  cadence: string;
  delivery: string;
  killCriterion: string;
  preset?: string;
  goals: string[];
  language?: string;
}

export interface RetireSuggestion {
  botId: string;
  reason: string;
}

export interface RosterProposed {
  proposalId: string;
  agentId: string;
  name: string;
  serves: string[];
}

export interface RosterDropped {
  name: string;
  reason: string;
}

export type RosterTrigger = 'manual' | 'scheduled' | 'brief-changed';

export interface RosterOutcome {
  at: string;
  trigger: RosterTrigger;
  status: 'proposed' | 'nothing' | 'unparsable' | 'refused' | 'failed';
  /** Why a refused / failed / nothing run ended, in words. */
  reason?: string;
  proposed: RosterProposed[];
  dropped: RosterDropped[];
  retire: RetireSuggestion[];
  questions: string[];
  note?: string;
  model?: string;
  tokens?: number;
  costUsd?: number;
}

export interface RosterState {
  /** The last run that reached the model. */
  lastRunAt?: string;
  lastAttemptAt?: string;
  /** The brief's `updatedAt` the last run that reached the model read. */
  briefSeen?: string;
  lastOutcome?: RosterOutcome;
}

/** A mind-proposed bot after approval, with what it did since. */
export interface RosterBotOutcome {
  botId: string;
  name: string;
  enabled: boolean;
  approvedAt: string;
  serves: string[];
  killCriterion?: string;
  cyclesCompleted: number;
  lastCycleAt?: string;
  productions: number;
  approved: number;
  rejected: number;
}

/** A mind proposal as the roster card lists it. */
export interface RosterProposalView {
  id: string;
  agentId: string;
  name: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  serves: string[];
  deliverable?: string;
  cadence?: string;
  killCriterion?: string;
}

/** `GET /api/watcher/roster`. */
export interface RosterStatus {
  enabled: boolean;
  /** Agent proposals are on (`agentProposals.enabled`); without them nothing can be proposed. */
  proposalsOn: boolean;
  running: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastOutcome: RosterOutcome | null;
  proposals: RosterProposalView[];
  bots: RosterBotOutcome[];
}

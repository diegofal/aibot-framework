/**
 * Autonomy rung 0 (`docs/plans/watcher-autonomy-plan.md`): the contract shared
 * by the proposal store, the change ledger, the routes and the dashboard.
 *
 * A proposal is a change the watcher (or, in rung 0, only code and tests)
 * asks the operator to approve. It is data, never code: a list of
 * `{ path, from, to }` over an allowlist of tunable config paths
 * (`locked.ts`). Everything outside that allowlist is locked: a proposal that
 * touches it is rejected when it is parsed and never shown for review (C2).
 * Only the operator approves, from an admin dashboard route, and the
 * approval names the content hash the operator saw (C3). Every applied
 * change keeps its before-values and can be reverted; a change whose guard
 * metric regresses within its window is rolled back by code (C4).
 *
 * Agreed shapes; add fields, never rename.
 */

/**
 * `threshold`: a watcher tunable inside its bounded range.
 * `fleet-cadence`: a bot's `agentLoop.every`.
 * `prompt-section`: reserved for rung 2 (editable prompt sections); rung 0 rejects it.
 */
export const PROPOSAL_KINDS = ['threshold', 'fleet-cadence', 'prompt-section'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * One value a proposal changes. `path` is a dotted config path:
 * `watcher.notice.salienceBar`, or `bots.<botId>.agentLoop.every`.
 * `from` is what the proposer saw; apply refuses if the live value differs.
 */
export interface ProposalChange {
  path: string;
  from: unknown;
  to: unknown;
}

export interface ProposalGuard {
  /** A guard metric name the guard reader knows (`guards.ts`). */
  metric: string;
  /** `max`: the change is rolled back if the metric rises above `bound`; `min`: if it falls below. */
  direction: 'min' | 'max';
  bound: number;
  /** How long after apply the guard is watched. */
  windowHours: number;
}

export interface ProposalPrediction {
  /** In plain words, what should happen. */
  effect: string;
  savingUsdPerWeek?: number;
  costUsdPerWeek?: number;
}

/** What a proposer submits; the store adds id, hash, status and times. */
export interface ProposalInput {
  kind: ProposalKind;
  title: string;
  rationale: string;
  /** Record ids it stands on: neuron `n-…`, cycle UUIDs, query-log or pass-record ids. At least one. */
  support: string[];
  changes: ProposalChange[];
  predicted: ProposalPrediction;
  guard: ProposalGuard;
  /** In plain words, what undoing it means. */
  rollback: string;
  /** Who proposed it. Rung 0: `watcher` or `test`. Never the operator: the operator edits config. */
  proposedBy: 'watcher' | 'test';
}

/**
 * `queued`: valid, waiting for a review slot (more than `maxPending` pending).
 * `pending`: shown for review; expires `approvalTtlHours` after it became pending.
 * `rejected-locked`: touched a locked path or an out-of-range value; never shown, kept for audit.
 */
export const PROPOSAL_STATUSES = [
  'queued',
  'pending',
  'approved',
  'rejected',
  'expired',
  'rejected-locked',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface Proposal extends ProposalInput {
  /** `p-` + 8 hex. */
  id: string;
  /** sha256 hex of the canonical JSON of the `ProposalInput` fields (`proposalHash`). */
  contentHash: string;
  status: ProposalStatus;
  createdAt: string;
  /** When it became `pending` (the expiry clock starts here). */
  pendingAt?: string;
  expiresAt?: string;
  decidedAt?: string;
  /** Always `operator` when set: nothing else can decide. */
  decidedBy?: 'operator';
  /** The operator's note on a rejection, or why parse rejected it (`rejected-locked`), or why apply failed. */
  note?: string;
  /** The change record an approval produced. */
  changeId?: string;
}

/**
 * Write-ahead (C4): every write of config values is preceded by an intent
 * record, and an intent is settled from the live values, never compensated.
 *
 * `applying`: intent recorded, the after-values may or may not be live yet.
 * `applied`: live. `apply-failed`: the write failed and nothing went live.
 * `reverting`: a revert (`cause: operator`) or rollback (`cause: guard`) is
 * recorded and not finished; it is always finished, whatever `guardUntil`
 * says. `reverted`: the operator undid it. `rolled-back`: its guard regressed
 * and code undid it. `revert-failed`: needs the operator: undoing it failed,
 * or the live values are neither the before- nor the after-values (`found`
 * holds what was live); the before-values are still here and nothing was
 * written over what someone else set.
 */
export type ChangeStatus =
  | 'applying'
  | 'applied'
  | 'apply-failed'
  | 'reverting'
  | 'reverted'
  | 'rolled-back'
  | 'revert-failed';

export interface ChangeRecord {
  /** `c-` + 8 hex. */
  id: string;
  proposalId: string;
  /**
   * The live values right before apply, per path. `raw` (only when the config
   * file held something else that expands to `value`, such as `${CADENCE}`;
   * `null` = absent from the file) is what a revert writes back to the file.
   */
  before: Array<{ path: string; value: unknown; raw?: unknown }>;
  after: Array<{ path: string; value: unknown }>;
  guard: ProposalGuard;
  appliedAt: string;
  /** `appliedAt + guard.windowHours`. */
  guardUntil: string;
  status: ChangeStatus;
  endedAt?: string;
  /** Why it ended (or, while `reverting`, why it is being undone): the operator's revert, or the guard reading. */
  endReason?: string;
  /** Who asked for the revert a `reverting` record (and what follows it) carries. */
  cause?: 'operator' | 'guard';
  /** The guard reading that started a rollback. */
  guardReading?: number;
  /** `revert-failed` from a settlement: the live values found, neither before nor after. */
  found?: Array<{ path: string; value: unknown }>;
}

/** `GET /api/watcher/proposals`. */
export interface ProposalsResponse {
  enabled: boolean;
  proposals: Proposal[];
  changes: ChangeRecord[];
  maxPending: number;
}

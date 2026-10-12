/**
 * Task workers — the shared contract (plan: docs/plans/goal-tasks-architecture-plan.md, C8–C22).
 *
 * A worker is a run of one agent on one goal task, in persisted bounded steps,
 * until the task is done, blocked or the budget is used. The cycle's planner
 * dispatches tasks; the pool (`WorkerPoolApi`) is the only place runs start.
 *
 * Every phase-1..4 workstream codes against these types. Change them only
 * deliberately: the planner, the pool, asks/restarts, the live view and the
 * upkeep builders all read the same shapes.
 */

import type { ToolFailureKind } from '../tools/types';

// ── Runs ──────────────────────────────────────────────────────────────────

export type WorkerRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'stopped'
  | 'interrupted';

/** Statuses of a run that still holds its task (claim kept, not finished). */
export const ACTIVE_RUN_STATUSES: readonly WorkerRunStatus[] = [
  'queued',
  'running',
  'waiting',
  'interrupted',
];

export function isActiveRun(status: WorkerRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

/**
 * What a tool call may have done to the world. `external` (messages, posts,
 * calls, exec) is never replayed on resume: a step whose journal holds one
 * goes to the operator instead.
 */
export type SideEffectClass = 'read' | 'write' | 'external';

export interface WorkerBudget {
  steps: number;
  toolCalls: number;
  wallMs: number;
}

export type WorkerUsage = WorkerBudget;

/** What a step ends with: exactly one report tool call. */
export interface StepReport {
  kind: 'progress' | 'done' | 'blocked';
  note: string;
}

export interface WorkerToolCall {
  name: string;
  /** Host + path of a URL, a file path or a command head — same rule as the tool audit's `target`. */
  target?: string;
  ok: boolean;
  sideEffect: SideEffectClass;
  /**
   * Why the call failed, as the executor reported it. `aborted` only for a
   * call refused before it ran (a call stopped mid-way has none: it was in
   * flight). Resume ignores calls refused without running (`REFUSED_FAILURES`).
   */
  failureKind?: ToolFailureKind;
}

/**
 * Failure kinds of a call that never ran (or ran nothing of ours): an
 * approval filed instead, a third party refusing, the write root, a policy
 * or denied / disabled tool, a cancelled run. A resume does not count them
 * as side effects.
 */
export const REFUSED_FAILURES: readonly ToolFailureKind[] = [
  'approval-pending',
  'blocked',
  'scope',
  'policy',
  'disabled',
  'aborted',
];

export interface WorkerStepRecord {
  n: number;
  startedAt: string;
  endedAt?: string;
  /** The report note plus a short tool list; the worker's memory between steps. */
  summary?: string;
  report?: StepReport;
  toolCalls: WorkerToolCall[];
  error?: string;
}

/** What a waiting run waits for (phase 2b). */
export interface WorkerWait {
  kind: 'ask' | 'approval';
  /** PendingQuestion id or permission request id. */
  id: string;
  question: string;
  since: string;
}

export type WorkerOutcomeKind =
  | 'done'
  | 'blocked'
  | 'budget'
  | 'failed'
  | 'stopped'
  | 'protocol'
  | 'interrupted';

export interface WorkerOutcome {
  kind: WorkerOutcomeKind;
  note: string;
}

export interface WorkerRun {
  runId: string;
  botId: string;
  taskId: string;
  goalId: string | null;
  /** Cycle that dispatched the run; null for operator retries. Never stamped as `cycleId` on rows. */
  dispatchCycleId: string | null;
  /** Snapshots for display, taken at dispatch. */
  taskText: string;
  goalTitle: string | null;
  status: WorkerRunStatus;
  attempt: number;
  /** Steps finished so far. */
  step: number;
  budget: WorkerBudget;
  used: WorkerUsage;
  createdAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  endedAt?: string;
  currentTool?: string;
  lastReport?: StepReport;
  wait?: WorkerWait;
  outcome?: WorkerOutcome;
  error?: string;
  /** Claim token on the task (never sent to the browser). */
  claimToken?: string;
}

/** A run as the API and the browser see it (no claim token). */
export type WorkerRunView = Omit<WorkerRun, 'claimToken'>;

export function toRunView(run: WorkerRun): WorkerRunView {
  const { claimToken: _token, ...view } = run;
  return view;
}

/** Append-only journal, one file per run: `<data>/workers/<botId>/<runId>.jsonl`. */
export type JournalEntry = { ts: string; runId: string } & (
  | { kind: 'run-start'; attempt: number }
  | { kind: 'step-start'; n: number }
  /**
   * Written before a tool call runs. A start without its `tool` entry means the
   * call was in flight when the process stopped: recovery treats it as done.
   */
  | ({ kind: 'tool-start'; n: number } & Omit<WorkerToolCall, 'ok'>)
  | ({ kind: 'tool'; n: number } & WorkerToolCall)
  | { kind: 'report'; n: number; report: StepReport }
  | { kind: 'step-end'; n: number; summary: string; error?: string }
  | { kind: 'wait'; wait: WorkerWait }
  /** `question`: set when the answer is to another question than the run's last wait. */
  | { kind: 'resume'; answer?: string; question?: string }
  | { kind: 'run-end'; status: WorkerRunStatus; outcome: WorkerOutcome }
);

// ── Pool ──────────────────────────────────────────────────────────────────

export interface DispatchRequest {
  botId: string;
  taskIds: string[];
  /** Cycle that decided it; null when the operator starts or retries a run. */
  cycleId: string | null;
}

export type DispatchRefusal =
  | 'disabled'
  | 'claimed'
  | 'not-found'
  | 'done'
  | 'cap'
  | 'budget'
  | 'quota'
  | 'breaker-open'
  | 'invalid';

export type DispatchResult =
  | { taskId: string; ok: true; runId: string; queued: boolean }
  | { taskId: string; ok: false; reason: DispatchRefusal; message: string };

/** An answer or decision routed to the run that asked (phase 2b). */
export interface WorkerAnswer {
  kind: 'ask' | 'approval';
  /** Question / request id the run is waiting on. */
  id: string;
  answer?: string;
  decision?: 'approved' | 'denied';
  /** Dismissed, closed stale or cleared: the run ends `blocked`. */
  dismissed?: boolean;
  /** The question it answers, when the store knows it. */
  question?: string;
}

export type StopReason = 'operator' | 'task-moved' | 'goal-closed' | 'shutdown' | 'sweep';

export interface WorkerPoolStats {
  running: number;
  queued: number;
  waiting: number;
  byBot: Record<string, { running: number; queued: number; waiting: number }>;
}

export interface WorkerPoolApi {
  /** Workers on for this bot (global flag + allowlist). */
  isEnabledFor(botId: string): boolean;
  /** Claim and queue the tasks; never waits for a run. */
  dispatch(req: DispatchRequest): DispatchResult[];
  /** Active runs (and up to `endedLimit` recently ended ones), newest first. */
  list(botId?: string, opts?: { endedLimit?: number }): WorkerRunView[];
  get(runId: string): WorkerRunView | null;
  journal(runId: string): JournalEntry[];
  /** Abort a run (really aborts the LLM call and tools). False when not active. */
  stop(runId: string, reason: StopReason): boolean;
  /** Start a new attempt of an ended run's task (operator). */
  retry(runId: string): DispatchResult;
  /**
   * Route an answer / decision / dismissal to a run (phase 2b). True when the
   * pool took it. False when no active run has that id, or the run is not
   * waiting on it yet (its step is still running): the store must then keep
   * it for `drainAnswers`, which the pool reads when the step parks the run.
   */
  onAnswer(runId: string, answer: WorkerAnswer): boolean;
  /** Shutdown: abort every run and persist `interrupted` synchronously before resolving. */
  abortAll(reason: StopReason): Promise<void>;
  /** Boot, before the agent loop starts: re-bind claims of interrupted runs, then re-queue them. */
  recover(): void;
  stats(): WorkerPoolStats;
  /** Live events (also published on the ActivityStream). Returns an unsubscribe. */
  subscribe(listener: (event: WorkerEvent) => void): () => void;
}

// ── Events (ActivityStream types + payloads) ─────────────────────────────

export type WorkerEventType =
  | 'worker:queued'
  | 'worker:started'
  | 'worker:step'
  | 'worker:tool'
  | 'worker:waiting'
  | 'worker:ended';

export const TASK_CHANGED_EVENT = 'task:changed' as const;

/** `data` of a `worker:*` ActivityStream event. */
export interface WorkerEventData {
  runId: string;
  taskId: string;
  goalId: string | null;
  status: WorkerRunStatus;
  step: number;
  budget: WorkerBudget;
  used: WorkerUsage;
  /** worker:tool — the tool that just started. */
  tool?: string;
  /** worker:step — the step's report. */
  report?: StepReport;
  /** worker:waiting */
  wait?: WorkerWait;
  /** worker:ended */
  outcome?: WorkerOutcome;
}

export interface WorkerEvent {
  type: WorkerEventType;
  botId: string;
  timestamp: number;
  data: WorkerEventData;
}

/** `data` of a `task:changed` ActivityStream event (any task write). */
export interface TaskChangedData {
  taskId: string;
  goalId: string;
  op: string;
  from?: string;
  to?: string;
  runId?: string;
  rev: number;
}

// ── Worker tools ─────────────────────────────────────────────────────────

/** The only way a step ends (C11). */
export const WORKER_REPORT_TOOLS = ['task_progress', 'task_done', 'task_blocked'] as const;
export type WorkerReportTool = (typeof WORKER_REPORT_TOOLS)[number];

/** Orchestration and outreach stay with the cycle (C13). */
export const WORKER_DENIED_TOOLS: readonly string[] = [
  'manage_goals',
  'collaborate',
  'delegate_to_bot',
  'create_agent',
  'cron',
  'send_proactive_message',
  'send_message',
];

/**
 * Tool names whose calls are `external` (non-idempotent) for resume. A tool on
 * no list (custom `create_tool` tools, skill, MCP and A2A tools) is `external`
 * too; only the known read-only and own-state lists in `worker.ts` are not.
 */
export const EXTERNAL_SIDE_EFFECT_TOOLS: readonly string[] = [
  'exec',
  'process',
  'send_message',
  'send_proactive_message',
  'twitter_post',
  'phone_call',
  'browser',
  'calendar_schedule',
  'mesh_publish',
  'moltbook_register',
  'create_tool',
  'collaborate',
  'delegate_to_bot',
  'create_agent',
  'cron',
];

// ── Planner output (phase 1) ─────────────────────────────────────────────

/** Optional planner fields, both planner modes. */
export interface PlannerTaskFields {
  /** Break a goal down: 2–5 concrete steps for a goal that has no open task. */
  new_tasks?: { goal: string; tasks: string[] };
  /** Open task ids to hand to workers (written new_tasks may be referenced by text). */
  dispatch?: string[];
  /** The task the cycle's own work serves (attribution), when it is not dispatched. */
  serves_task?: string;
  /** A goal with no end state (a habit, a recurring duty): it gets no tasks; the cycle does a round of it. */
  standing_goal?: string;
}

// ── Config ───────────────────────────────────────────────────────────────

export interface WorkersConfig {
  enabled: boolean;
  /** Bot ids allowed to run workers; empty = every bot when enabled. */
  bots: string[];
  maxConcurrent: number;
  maxPerBot: number;
  budget: WorkerBudget;
  stepTimeoutMs: number;
  /** Tool rounds per step on Ollama (claude-cli is bounded by the callback counter). */
  maxToolRoundsPerStep: number;
  dailyStepsPerBot: number;
  claimTtlMs: number;
  maxAttempts: number;
  sweepIntervalMs: number;
}

export const WORKERS_DEFAULTS: WorkersConfig = {
  enabled: false,
  bots: [],
  maxConcurrent: 2,
  maxPerBot: 1,
  budget: { steps: 8, toolCalls: 40, wallMs: 60 * 60_000 },
  stepTimeoutMs: 300_000,
  maxToolRoundsPerStep: 12,
  dailyStepsPerBot: 60,
  claimTtlMs: 30 * 60_000,
  maxAttempts: 2,
  sweepIntervalMs: 60_000,
};

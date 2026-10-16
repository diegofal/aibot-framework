export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

export type CronPayload =
  | { kind: 'message'; text: string; chatId: number; botId: string }
  | { kind: 'instruction'; text: string; chatId: number; botId: string }
  | {
      kind: 'skillJob';
      skillId: string;
      jobId: string;
      botId?: string;
      llmBackend?: 'ollama' | 'claude-cli';
      claudePath?: string;
      claudeTimeout?: number;
    };

export type CronPayloadPatch =
  | { kind: 'message'; text?: string; chatId?: number; botId?: string }
  | { kind: 'instruction'; text?: string; chatId?: number; botId?: string }
  | {
      kind: 'skillJob';
      skillId?: string;
      jobId?: string;
      botId?: string;
      llmBackend?: 'ollama' | 'claude-cli' | null;
      claudePath?: string | null;
      claudeTimeout?: number | null;
    };

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors: number;
};

/**
 * Who set a job up: an agent through the `cron` tool (with the work cycle and
 * goal it was in, when it was in one) or the operator on the dashboard. Jobs
 * written before this existed have none.
 */
/**
 * Who asked the agent for a job (the cron tool's caller, by the operator
 * gate's rule — `callerIdentity` in `src/tools/operator-gate.ts`): the bot's
 * own run, the operator (verified), or anyone else. Decides whether the job
 * may later run as the bot itself (`src/cron/trust.ts`). Absent on jobs
 * created before 2026-10-16.
 */
export type CronRequester =
  | { kind: 'self' }
  | { kind: 'operator'; channelKind: string }
  | { kind: 'other'; channelKind?: string; address?: string };

export type CronCreatedBy =
  | {
      kind: 'agent';
      botId: string;
      cycleId?: string;
      goalId?: string;
      requestedBy?: CronRequester;
    }
  | { kind: 'operator' };

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  payload: CronPayload;
  state: CronJobState;
  createdBy?: CronCreatedBy;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'> & {
  state?: Partial<CronJobState>;
};

export type CronJobPatch = Partial<
  Omit<CronJob, 'id' | 'createdAtMs' | 'state' | 'payload' | 'createdBy'>
> & {
  payload?: CronPayloadPatch;
  state?: Partial<CronJobState>;
};

export type CronEvent = {
  jobId: string;
  action: 'added' | 'updated' | 'removed' | 'started' | 'finished';
  runAtMs?: number;
  durationMs?: number;
  status?: 'ok' | 'error' | 'skipped';
  error?: string;
  nextRunAtMs?: number;
};

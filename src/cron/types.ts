export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

export type CronPayload =
  | { kind: 'message'; text: string; chatId: number; botId: string }
  | { kind: 'skillJob'; skillId: string; jobId: string };

export type CronPayloadPatch =
  | { kind: 'message'; text?: string; chatId?: number; botId?: string }
  | { kind: 'skillJob'; skillId?: string; jobId?: string };

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors: number;
};

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
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'> & {
  state?: Partial<CronJobState>;
};

export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAtMs' | 'state' | 'payload'>> & {
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

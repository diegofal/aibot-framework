import path from 'node:path';
import type { Logger } from '../logger';
import {
  applyJobPatch,
  computeJobNextRunAtMs,
  createJob,
  findJobOrThrow,
  nextWakeAtMs,
  recomputeNextRuns,
} from './jobs';
import { locked } from './locked';
import { readCronRunLogEntries, resolveCronRunLogPath } from './run-log';
import { loadCronStore, saveCronStore } from './store';
import { armTimer, executeJob, isJobDue, stopTimer } from './timer';
import type { CronEvent, CronJob, CronJobCreate, CronJobPatch, CronStoreFile } from './types';

export type CronServiceDeps = {
  logger: Logger;
  storePath: string;
  cronEnabled: boolean;
  sendMessage: (chatId: number, text: string, botId: string) => Promise<void>;
  resolveSkillHandler: (skillId: string, jobId: string) => (() => Promise<void>) | undefined;
  onEvent?: (evt: CronEvent) => void;
};

export type CronServiceState = {
  deps: CronServiceDeps & { nowMs: () => number };
  store: CronStoreFile | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  op: Promise<unknown>;
  warnedDisabled: boolean;
  ensureLoaded: (opts?: { forceReload?: boolean; skipRecompute?: boolean }) => Promise<void>;
  persist: () => Promise<void>;
};

function createState(deps: CronServiceDeps): CronServiceState {
  const storeFilePath = path.join(deps.storePath, 'jobs.json');
  const internalDeps = { ...deps, nowMs: () => Date.now() };

  const state: CronServiceState = {
    deps: internalDeps,
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,

    async ensureLoaded(opts) {
      if (state.store && !opts?.forceReload) {
        return;
      }
      const loaded = await loadCronStore(storeFilePath);
      // Ensure all jobs have a valid state
      for (const job of loaded.jobs) {
        if (!job.state) {
          (job as { state: CronJob['state'] }).state = { consecutiveErrors: 0 };
        }
        if (typeof job.state.consecutiveErrors !== 'number') {
          job.state.consecutiveErrors = 0;
        }
      }
      state.store = loaded;
      if (!opts?.skipRecompute) {
        recomputeNextRuns(state);
      }
    },

    async persist() {
      if (!state.store) {
        return;
      }
      await saveCronStore(storeFilePath, state.store);
    },
  };

  // Override storePath to be the actual file path for run-log resolution
  (state.deps as { storePath: string }).storePath = storeFilePath;

  return state;
}

export class CronService {
  private readonly state: CronServiceState;

  constructor(deps: CronServiceDeps) {
    this.state = createState(deps);
  }

  async start(): Promise<void> {
    await locked(this.state, async () => {
      if (!this.state.deps.cronEnabled) {
        this.state.deps.logger.info({ enabled: false }, 'CronService disabled');
        return;
      }
      await this.state.ensureLoaded({ skipRecompute: true });
      const jobs = this.state.store?.jobs ?? [];
      // Clear stale running markers from previous crash
      for (const job of jobs) {
        if (typeof job.state.runningAtMs === 'number') {
          this.state.deps.logger.warn(
            { jobId: job.id, runningAtMs: job.state.runningAtMs },
            'cron: clearing stale running marker on startup'
          );
          job.state.runningAtMs = undefined;
        }
      }
      recomputeNextRuns(this.state);
      await this.state.persist();
      armTimer(this.state);
      this.state.deps.logger.info(
        {
          enabled: true,
          jobs: this.state.store?.jobs.length ?? 0,
          nextWakeAtMs: nextWakeAtMs(this.state) ?? null,
        },
        'CronService started'
      );
    });
  }

  stop(): void {
    stopTimer(this.state);
    this.state.deps.logger.info('CronService stopped');
  }

  async list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]> {
    return await locked(this.state, async () => {
      await this.state.ensureLoaded({ skipRecompute: true });
      if (this.state.store) {
        const changed = recomputeNextRuns(this.state);
        if (changed) {
          await this.state.persist();
        }
      }
      const includeDisabled = opts?.includeDisabled === true;
      const jobs = (this.state.store?.jobs ?? []).filter((j) => includeDisabled || j.enabled);
      return jobs.toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
    });
  }

  async add(input: CronJobCreate): Promise<CronJob> {
    return await locked(this.state, async () => {
      await this.state.ensureLoaded();
      const job = createJob(this.state, input);
      this.state.store?.jobs.push(job);
      recomputeNextRuns(this.state);
      await this.state.persist();
      armTimer(this.state);

      this.state.deps.logger.info(
        {
          jobId: job.id,
          jobName: job.name,
          nextRunAtMs: job.state.nextRunAtMs,
        },
        'cron: job added'
      );

      try {
        this.state.deps.onEvent?.({
          jobId: job.id,
          action: 'added',
          nextRunAtMs: job.state.nextRunAtMs,
        });
      } catch {
        /* ignore */
      }

      return job;
    });
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJob> {
    return await locked(this.state, async () => {
      await this.state.ensureLoaded();
      const job = findJobOrThrow(this.state, id);
      const now = this.state.deps.nowMs();
      applyJobPatch(job, patch);

      if (job.schedule.kind === 'every') {
        const anchor = job.schedule.anchorMs;
        if (typeof anchor !== 'number' || !Number.isFinite(anchor)) {
          job.schedule = {
            ...job.schedule,
            anchorMs: Math.max(0, Math.floor(job.createdAtMs)),
          };
        }
      }

      const scheduleChanged = patch.schedule !== undefined;
      const enabledChanged = patch.enabled !== undefined;
      job.updatedAtMs = now;
      if (scheduleChanged || enabledChanged) {
        if (job.enabled) {
          job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
        } else {
          job.state.nextRunAtMs = undefined;
          job.state.runningAtMs = undefined;
        }
      }

      await this.state.persist();
      armTimer(this.state);

      try {
        this.state.deps.onEvent?.({
          jobId: id,
          action: 'updated',
          nextRunAtMs: job.state.nextRunAtMs,
        });
      } catch {
        /* ignore */
      }

      return job;
    });
  }

  async remove(id: string): Promise<{ ok: boolean; removed: boolean }> {
    return await locked(this.state, async () => {
      await this.state.ensureLoaded();
      const before = this.state.store?.jobs.length ?? 0;
      if (!this.state.store) {
        return { ok: false, removed: false };
      }
      this.state.store.jobs = this.state.store.jobs.filter((j) => j.id !== id);
      const removed = this.state.store.jobs.length !== before;
      await this.state.persist();
      armTimer(this.state);
      if (removed) {
        try {
          this.state.deps.onEvent?.({ jobId: id, action: 'removed' });
        } catch {
          /* ignore */
        }
      }
      return { ok: true, removed };
    });
  }

  async run(
    id: string,
    mode?: 'due' | 'force'
  ): Promise<{ ok: boolean; ran: boolean; reason?: string }> {
    return await locked(this.state, async () => {
      await this.state.ensureLoaded({ skipRecompute: true });
      const job = findJobOrThrow(this.state, id);
      if (typeof job.state.runningAtMs === 'number') {
        return { ok: true, ran: false, reason: 'already-running' };
      }
      const now = this.state.deps.nowMs();
      const due = isJobDue(job, now, { forced: mode === 'force' });
      if (!due) {
        return { ok: true, ran: false, reason: 'not-due' };
      }
      await executeJob(this.state, job, { forced: mode === 'force' });
      recomputeNextRuns(this.state);
      await this.state.persist();
      armTimer(this.state);
      return { ok: true, ran: true };
    });
  }

  async status(): Promise<{
    enabled: boolean;
    storePath: string;
    jobs: number;
    nextWakeAtMs: number | null;
  }> {
    return await locked(this.state, async () => {
      await this.state.ensureLoaded({ skipRecompute: true });
      if (this.state.store) {
        const changed = recomputeNextRuns(this.state);
        if (changed) {
          await this.state.persist();
        }
      }
      return {
        enabled: this.state.deps.cronEnabled,
        storePath: this.state.deps.storePath,
        jobs: this.state.store?.jobs.length ?? 0,
        nextWakeAtMs: this.state.deps.cronEnabled ? (nextWakeAtMs(this.state) ?? null) : null,
      };
    });
  }

  async runs(jobId: string, opts?: { limit?: number }): Promise<unknown[]> {
    const logPath = resolveCronRunLogPath({
      storePath: path.join(this.state.deps.storePath, 'jobs.json'),
      jobId,
    });
    return await readCronRunLogEntries(logPath, { limit: opts?.limit, jobId });
  }
}

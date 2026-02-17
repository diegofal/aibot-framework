import { computeJobNextRunAtMs, nextWakeAtMs, recomputeNextRuns } from './jobs';
import { locked } from './locked';
import { appendCronRunLog, resolveCronRunLogPath } from './run-log';
import type { CronServiceState } from './service';
import type { CronJob } from './types';

const MAX_TIMER_DELAY_MS = 60_000;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

const ERROR_BACKOFF_SCHEDULE_MS = [
  30_000, // 1st error  →  30 s
  60_000, // 2nd error  →   1 min
  5 * 60_000, // 3rd error  →   5 min
  15 * 60_000, // 4th error  →  15 min
  60 * 60_000, // 5th+ error →  60 min
];

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}

function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: 'ok' | 'error' | 'skipped';
    error?: string;
    startedAt: number;
    endedAt: number;
  }
): boolean {
  job.state.runningAtMs = undefined;
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastStatus = result.status;
  job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
  job.state.lastError = result.error;
  job.updatedAtMs = result.endedAt;

  if (result.status === 'error') {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
  } else {
    job.state.consecutiveErrors = 0;
  }

  const shouldDelete =
    job.schedule.kind === 'at' && result.status === 'ok' && job.deleteAfterRun === true;

  if (!shouldDelete) {
    if (job.schedule.kind === 'at') {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      if (result.status === 'error') {
        state.deps.logger.warn(
          {
            jobId: job.id,
            jobName: job.name,
            consecutiveErrors: job.state.consecutiveErrors,
            error: result.error,
          },
          'cron: disabling one-shot job after error'
        );
      }
    } else if (result.status === 'error' && job.enabled) {
      const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
      const normalNext = computeJobNextRunAtMs(job, result.endedAt);
      const backoffNext = result.endedAt + backoff;
      job.state.nextRunAtMs =
        normalNext !== undefined ? Math.max(normalNext, backoffNext) : backoffNext;
      state.deps.logger.info(
        {
          jobId: job.id,
          consecutiveErrors: job.state.consecutiveErrors,
          backoffMs: backoff,
          nextRunAtMs: job.state.nextRunAtMs,
        },
        'cron: applying error backoff'
      );
    } else if (job.enabled) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, result.endedAt);
    } else {
      job.state.nextRunAtMs = undefined;
    }
  }

  return shouldDelete;
}

export function armTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
  if (!state.deps.cronEnabled) {
    return;
  }
  const nextAt = nextWakeAtMs(state);
  if (!nextAt) {
    return;
  }
  const now = state.deps.nowMs();
  const delay = Math.max(nextAt - now, 0);
  const clampedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
  state.timer = setTimeout(async () => {
    try {
      await onTimer(state);
    } catch (err) {
      state.deps.logger.error({ err: String(err) }, 'cron: timer tick failed');
    }
  }, clampedDelay);
  state.deps.logger.debug(
    { nextAt, delayMs: clampedDelay, clamped: delay > MAX_TIMER_DELAY_MS },
    'cron: timer armed'
  );
}

export function stopTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}

function emit(
  state: CronServiceState,
  evt: CronServiceState['deps'] extends { onEvent?: infer F }
    ? F extends (e: infer E) => void
      ? E
      : never
    : never
) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}

function findDueJobs(state: CronServiceState): CronJob[] {
  if (!state.store) {
    return [];
  }
  const now = state.deps.nowMs();
  return state.store.jobs.filter((j) => {
    if (!j.enabled) {
      return false;
    }
    if (typeof j.state.runningAtMs === 'number') {
      return false;
    }
    const next = j.state.nextRunAtMs;
    return typeof next === 'number' && now >= next;
  });
}

async function executeJobCore(
  state: CronServiceState,
  job: CronJob
): Promise<{ status: 'ok' | 'error' | 'skipped'; error?: string; output?: string }> {
  if (job.payload.kind === 'message') {
    try {
      await state.deps.sendMessage(job.payload.chatId, job.payload.text, job.payload.botId);
      return { status: 'ok', output: 'Message sent' };
    } catch (err) {
      return { status: 'error', error: String(err) };
    }
  }

  if (job.payload.kind === 'skillJob') {
    const handler = state.deps.resolveSkillHandler(job.payload);
    if (!handler) {
      return {
        status: 'skipped',
        error: `Skill handler not found: ${job.payload.skillId}/${job.payload.jobId}`,
      };
    }
    try {
      const result = await handler();
      return { status: 'ok', output: result || undefined };
    } catch (err) {
      return { status: 'error', error: String(err) };
    }
  }

  return { status: 'skipped', error: 'Unknown payload kind' };
}

async function onTimer(state: CronServiceState) {
  if (state.running) {
    return;
  }
  state.running = true;
  try {
    const dueJobs = await locked(state, async () => {
      await state.ensureLoaded({ forceReload: true, skipRecompute: true });
      const due = findDueJobs(state);

      if (due.length === 0) {
        const changed = recomputeNextRuns(state);
        if (changed) {
          await state.persist();
        }
        return [];
      }

      const now = state.deps.nowMs();
      for (const job of due) {
        job.state.runningAtMs = now;
        job.state.lastError = undefined;
      }
      await state.persist();

      return due.map((j) => ({ id: j.id, job: j }));
    });

    const results: Array<{
      jobId: string;
      status: 'ok' | 'error' | 'skipped';
      error?: string;
      output?: string;
      startedAt: number;
      endedAt: number;
    }> = [];

    for (const { id, job } of dueJobs) {
      const startedAt = state.deps.nowMs();
      job.state.runningAtMs = startedAt;
      emit(state, { jobId: job.id, action: 'started', runAtMs: startedAt });

      try {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          executeJobCore(state, job),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('cron: job execution timed out')),
              DEFAULT_JOB_TIMEOUT_MS
            );
          }),
        ]).finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });
        results.push({ jobId: id, ...result, startedAt, endedAt: state.deps.nowMs() });
      } catch (err) {
        state.deps.logger.warn(
          { jobId: id, jobName: job.name },
          `cron: job failed: ${String(err)}`
        );
        results.push({
          jobId: id,
          status: 'error',
          error: String(err),
          startedAt,
          endedAt: state.deps.nowMs(),
        });
      }
    }

    if (results.length > 0) {
      await locked(state, async () => {
        await state.ensureLoaded({ forceReload: true, skipRecompute: true });

        for (const result of results) {
          const job = state.store?.jobs.find((j) => j.id === result.jobId);
          if (!job) {
            continue;
          }

          const shouldDelete = applyJobResult(state, job, {
            status: result.status,
            error: result.error,
            startedAt: result.startedAt,
            endedAt: result.endedAt,
          });

          emit(state, {
            jobId: job.id,
            action: 'finished',
            status: result.status,
            error: result.error,
            runAtMs: result.startedAt,
            durationMs: job.state.lastDurationMs,
            nextRunAtMs: job.state.nextRunAtMs,
          });

          // Append to run log
          const logPath = resolveCronRunLogPath({ storePath: state.deps.storePath, jobId: job.id });
          appendCronRunLog(logPath, {
            ts: result.endedAt,
            jobId: job.id,
            action: 'finished',
            status: result.status,
            error: result.error,
            output: result.output,
            runAtMs: result.startedAt,
            durationMs: job.state.lastDurationMs,
            nextRunAtMs: job.state.nextRunAtMs,
          }).catch(() => {});

          if (shouldDelete && state.store) {
            state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
            emit(state, { jobId: job.id, action: 'removed' });
          }
        }

        recomputeNextRuns(state);
        await state.persist();
      });
    }
  } finally {
    state.running = false;
    armTimer(state);
  }
}

export async function executeJob(
  state: CronServiceState,
  job: CronJob,
  _opts: { forced: boolean }
) {
  if (!job.state) {
    (job as { state: CronJob['state'] }).state = { consecutiveErrors: 0 };
  }
  const startedAt = state.deps.nowMs();
  job.state.runningAtMs = startedAt;
  job.state.lastError = undefined;
  emit(state, { jobId: job.id, action: 'started', runAtMs: startedAt });

  let coreResult: { status: 'ok' | 'error' | 'skipped'; error?: string; output?: string };
  try {
    coreResult = await executeJobCore(state, job);
  } catch (err) {
    coreResult = { status: 'error', error: String(err) };
  }

  const endedAt = state.deps.nowMs();
  const shouldDelete = applyJobResult(state, job, {
    status: coreResult.status,
    error: coreResult.error,
    startedAt,
    endedAt,
  });

  emit(state, {
    jobId: job.id,
    action: 'finished',
    status: coreResult.status,
    error: coreResult.error,
    runAtMs: startedAt,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
  });

  // Append to run log
  const logPath = resolveCronRunLogPath({ storePath: state.deps.storePath, jobId: job.id });
  appendCronRunLog(logPath, {
    ts: endedAt,
    jobId: job.id,
    action: 'finished',
    status: coreResult.status,
    error: coreResult.error,
    output: coreResult.output,
    runAtMs: startedAt,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
  }).catch(() => {});

  if (shouldDelete && state.store) {
    state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
    emit(state, { jobId: job.id, action: 'removed' });
  }
}

export function isJobDue(job: CronJob, nowMs: number, opts: { forced: boolean }) {
  if (typeof job.state.runningAtMs === 'number') {
    return false;
  }
  if (opts.forced) {
    return true;
  }
  return job.enabled && typeof job.state.nextRunAtMs === 'number' && nowMs >= job.state.nextRunAtMs;
}

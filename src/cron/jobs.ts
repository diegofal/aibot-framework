import crypto from 'node:crypto';
import { computeNextRunAtMs } from './schedule';
import type { CronServiceState } from './service';
import type { CronJob, CronJobCreate, CronJobPatch, CronPayload, CronPayloadPatch } from './types';

const STUCK_RUN_MS = 2 * 60 * 60 * 1000;

function resolveEveryAnchorMs(params: {
  schedule: { everyMs: number; anchorMs?: number };
  fallbackAnchorMs: number;
}) {
  const raw = params.schedule.anchorMs;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  return Math.max(0, Math.floor(params.fallbackAnchorMs));
}

export function findJobOrThrow(state: CronServiceState, id: string) {
  const job = state.store?.jobs.find((j) => j.id === id);
  if (!job) {
    throw new Error(`Unknown cron job id: ${id}`);
  }
  return job;
}

export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (!job.enabled) {
    return undefined;
  }
  if (job.schedule.kind === 'every') {
    const anchorMs = resolveEveryAnchorMs({
      schedule: job.schedule,
      fallbackAnchorMs: job.createdAtMs,
    });
    return computeNextRunAtMs({ ...job.schedule, anchorMs }, nowMs);
  }
  if (job.schedule.kind === 'at') {
    if (job.state.lastStatus === 'ok' && job.state.lastRunAtMs) {
      return undefined;
    }
    const atMs = new Date(job.schedule.at).getTime();
    return Number.isFinite(atMs) ? atMs : undefined;
  }
  return computeNextRunAtMs(job.schedule, nowMs);
}

export function recomputeNextRuns(state: CronServiceState): boolean {
  if (!state.store) {
    return false;
  }
  let changed = false;
  const now = state.deps.nowMs();
  for (const job of state.store.jobs) {
    if (!job.state) {
      (job as { state: CronJob['state'] }).state = { consecutiveErrors: 0 };
      changed = true;
    }
    if (!job.enabled) {
      if (job.state.nextRunAtMs !== undefined) {
        job.state.nextRunAtMs = undefined;
        changed = true;
      }
      if (job.state.runningAtMs !== undefined) {
        job.state.runningAtMs = undefined;
        changed = true;
      }
      continue;
    }
    const runningAt = job.state.runningAtMs;
    if (typeof runningAt === 'number' && now - runningAt > STUCK_RUN_MS) {
      state.deps.logger.warn(
        { jobId: job.id, runningAtMs: runningAt },
        'cron: clearing stuck running marker'
      );
      job.state.runningAtMs = undefined;
      changed = true;
    }
    const nextRun = job.state.nextRunAtMs;
    const isDueOrMissing = nextRun === undefined || now >= nextRun;
    if (isDueOrMissing) {
      const newNext = computeJobNextRunAtMs(job, now);
      if (job.state.nextRunAtMs !== newNext) {
        job.state.nextRunAtMs = newNext;
        changed = true;
      }
    }
  }
  return changed;
}

export function nextWakeAtMs(state: CronServiceState) {
  const jobs = state.store?.jobs ?? [];
  const enabled = jobs.filter((j) => j.enabled && typeof j.state.nextRunAtMs === 'number');
  if (enabled.length === 0) {
    return undefined;
  }
  return enabled.reduce(
    (min, j) => Math.min(min, j.state.nextRunAtMs as number),
    enabled[0].state.nextRunAtMs as number
  );
}

export function createJob(state: CronServiceState, input: CronJobCreate): CronJob {
  const now = state.deps.nowMs();
  const id = crypto.randomUUID();
  const schedule =
    input.schedule.kind === 'every'
      ? {
          ...input.schedule,
          anchorMs: resolveEveryAnchorMs({
            schedule: input.schedule,
            fallbackAnchorMs: now,
          }),
        }
      : input.schedule;
  const deleteAfterRun =
    typeof input.deleteAfterRun === 'boolean'
      ? input.deleteAfterRun
      : schedule.kind === 'at'
        ? true
        : undefined;
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
  const job: CronJob = {
    id,
    name: input.name?.trim() || 'Unnamed job',
    description: input.description?.trim() || undefined,
    enabled,
    deleteAfterRun,
    createdAtMs: now,
    updatedAtMs: now,
    schedule,
    payload: input.payload,
    state: {
      consecutiveErrors: 0,
      ...input.state,
    },
  };
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
  return job;
}

export function applyJobPatch(job: CronJob, patch: CronJobPatch) {
  if ('name' in patch && patch.name) {
    job.name = patch.name.trim() || job.name;
  }
  if ('description' in patch) {
    job.description = patch.description?.trim() || undefined;
  }
  if (typeof patch.enabled === 'boolean') {
    job.enabled = patch.enabled;
  }
  if (typeof patch.deleteAfterRun === 'boolean') {
    job.deleteAfterRun = patch.deleteAfterRun;
  }
  if (patch.schedule) {
    job.schedule = patch.schedule;
  }
  if (patch.payload) {
    job.payload = mergeCronPayload(job.payload, patch.payload);
  }
  if (patch.state) {
    job.state = { ...job.state, ...patch.state };
  }
}

function mergeCronPayload(existing: CronPayload, patch: CronPayloadPatch): CronPayload {
  if (patch.kind !== existing.kind) {
    return buildPayloadFromPatch(patch);
  }

  if (patch.kind === 'message' && existing.kind === 'message') {
    return {
      kind: 'message',
      text: typeof patch.text === 'string' ? patch.text : existing.text,
      chatId: typeof patch.chatId === 'number' ? patch.chatId : existing.chatId,
      botId: typeof patch.botId === 'string' ? patch.botId : existing.botId,
    };
  }

  if (patch.kind === 'skillJob' && existing.kind === 'skillJob') {
    return {
      kind: 'skillJob',
      skillId: typeof patch.skillId === 'string' ? patch.skillId : existing.skillId,
      jobId: typeof patch.jobId === 'string' ? patch.jobId : existing.jobId,
    };
  }

  return existing;
}

function buildPayloadFromPatch(patch: CronPayloadPatch): CronPayload {
  if (patch.kind === 'message') {
    if (typeof patch.text !== 'string' || !patch.text) {
      throw new Error('cron: message payload requires text');
    }
    if (typeof patch.chatId !== 'number') {
      throw new Error('cron: message payload requires chatId');
    }
    if (typeof patch.botId !== 'string' || !patch.botId) {
      throw new Error('cron: message payload requires botId');
    }
    return { kind: 'message', text: patch.text, chatId: patch.chatId, botId: patch.botId };
  }

  if (typeof patch.skillId !== 'string' || !patch.skillId) {
    throw new Error('cron: skillJob payload requires skillId');
  }
  if (typeof patch.jobId !== 'string' || !patch.jobId) {
    throw new Error('cron: skillJob payload requires jobId');
  }
  return { kind: 'skillJob', skillId: patch.skillId, jobId: patch.jobId };
}

import { join } from 'node:path';
import type { CronJob, CronSchedule, CronStoreFile } from '../../cron/types';
import type { InfraResponse } from '../types';
import { readJsonSafe, toIso } from '../util';

export type CronJobStats = InfraResponse['cron'][number];

export function describeSchedule(schedule: CronSchedule | undefined): string {
  if (!schedule) return 'unknown';
  switch (schedule.kind) {
    case 'cron':
      return `cron ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
    case 'every':
      return `every ${humanMs(schedule.everyMs)}`;
    case 'at':
      return `at ${schedule.at}`;
    default:
      return 'unknown';
  }
}

function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export function readCronJobs(storePath: string): CronJobStats[] {
  const raw = readJsonSafe<CronStoreFile>(join(storePath, 'jobs.json'));
  const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
  return jobs.map((job: CronJob) => {
    const state = job.state ?? { consecutiveErrors: 0 };
    const payload = job.payload as { botId?: string } | undefined;
    return {
      id: job.id,
      name: job.name ?? job.id,
      botId: payload?.botId ?? null,
      schedule: describeSchedule(job.schedule),
      enabled: job.enabled !== false,
      lastStatus: state.lastStatus ?? null,
      lastError: state.lastError ?? null,
      lastRunAt: toIso(state.lastRunAtMs),
      nextRunAt: toIso(state.nextRunAtMs),
      consecutiveErrors: Number(state.consecutiveErrors) || 0,
    };
  });
}

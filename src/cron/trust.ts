/**
 * Whether a fired cron job may run as the bot itself (`_actor: 'self'`, which
 * lets personal-data tools answer). Only who created the job decides, never
 * where it delivers: anyone can name the operator's chat.
 *
 * Trusted: a job you created on the dashboard (`createdBy.kind: 'operator'`),
 * and an agent job requested by the bot's own run or by the verified operator
 * (`requestedBy`). Jobs from before `requestedBy` existed are trusted only if
 * they were created inside an agent-loop cycle (`cycleId`, which the executor
 * stamps only there); a job created in a chat, or with no `createdBy` at all,
 * is not — it still runs, but its personal-data tools refuse.
 */
import type { CronJob } from './types';

export function cronJobRunsAsSelf(job: Pick<CronJob, 'createdBy'>): boolean {
  const by = job.createdBy;
  if (!by) return false;
  if (by.kind === 'operator') return true;
  if (by.requestedBy) return by.requestedBy.kind !== 'other';
  return typeof by.cycleId === 'string' && by.cycleId.length > 0;
}

/**
 * Whether a fired cron job runs for the operator (`_actor: 'operator-cron'`,
 * which lets personal-data tools answer). Only who created the job decides,
 * never where it delivers: anyone can name the operator's chat.
 *
 * Trusted: a job the operator created on the dashboard (`createdBy.kind:
 * 'operator'`, stamped only for admin / single-tenant callers) and an agent
 * job the verified operator asked for (`requestedBy.kind: 'operator'`). Not
 * trusted: jobs from the bot's own runs (`self`, or old jobs with only a
 * `cycleId`), since anyone can plant the goals those runs act on; jobs anyone
 * else asked for; tenant API jobs; jobs with no `createdBy`. They still run;
 * their personal-data tools refuse.
 */
import type { CronJob } from './types';

export function cronJobRunsForOperator(job: Pick<CronJob, 'createdBy'>): boolean {
  const by = job.createdBy;
  if (!by) return false;
  if (by.kind === 'operator') return true;
  if (by.kind === 'agent') return by.requestedBy?.kind === 'operator';
  return false;
}

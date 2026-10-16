import { describe, expect, test } from 'bun:test';
import { cronJobRunsForOperator } from '../../src/cron/trust';
import type { CronJob } from '../../src/cron/types';

const job = (createdBy?: CronJob['createdBy']) => ({ createdBy }) as Pick<CronJob, 'createdBy'>;
const agent = (requestedBy?: unknown, cycleId?: string) =>
  job({
    kind: 'agent',
    botId: 'b',
    ...(cycleId ? { cycleId } : {}),
    ...(requestedBy ? { requestedBy } : {}),
  } as CronJob['createdBy']);

describe('cronJobRunsForOperator — may a fired job reach personal data?', () => {
  test('a job you created on the dashboard (admin / single-tenant) → yes', () => {
    expect(cronJobRunsForOperator(job({ kind: 'operator' }))).toBe(true);
  });

  test('a job the verified operator asked the agent for → yes', () => {
    expect(cronJobRunsForOperator(agent({ kind: 'operator', channelKind: 'telegram' }))).toBe(true);
    expect(cronJobRunsForOperator(agent({ kind: 'operator', channelKind: 'dashboard' }))).toBe(
      true
    );
  });

  // Anyone can plant goals that a later cycle turns into a job.
  test("a job from the bot's own run → no (new or old, with or without a cycle)", () => {
    expect(cronJobRunsForOperator(agent({ kind: 'self' }))).toBe(false);
    expect(cronJobRunsForOperator(agent(undefined, 'c1'))).toBe(false);
    expect(cronJobRunsForOperator(agent())).toBe(false);
  });

  test('a job anyone else asked for → no', () => {
    expect(cronJobRunsForOperator(agent({ kind: 'other', channelKind: 'web', address: 'x' }))).toBe(
      false
    );
  });

  test('a tenant API job, or no createdBy at all → no', () => {
    expect(cronJobRunsForOperator(job({ kind: 'tenant', tenantId: 'acme' }))).toBe(false);
    expect(cronJobRunsForOperator(job())).toBe(false);
  });
});

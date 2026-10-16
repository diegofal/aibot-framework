import { describe, expect, test } from 'bun:test';
import { cronJobRunsAsSelf } from '../../src/cron/trust';
import type { CronJob } from '../../src/cron/types';

const job = (createdBy?: CronJob['createdBy']) => ({ createdBy }) as Pick<CronJob, 'createdBy'>;

describe('cronJobRunsAsSelf — may a fired job act as the bot itself?', () => {
  test('a job you created on the dashboard → yes', () => {
    expect(cronJobRunsAsSelf(job({ kind: 'operator' }))).toBe(true);
  });

  test('a job the bot created in its own run, or for the verified operator → yes', () => {
    expect(
      cronJobRunsAsSelf(job({ kind: 'agent', botId: 'b', requestedBy: { kind: 'self' } }))
    ).toBe(true);
    expect(
      cronJobRunsAsSelf(
        job({
          kind: 'agent',
          botId: 'b',
          requestedBy: { kind: 'operator', channelKind: 'telegram' },
        })
      )
    ).toBe(true);
  });

  test('a job anyone else asked for → no', () => {
    expect(
      cronJobRunsAsSelf(
        job({
          kind: 'agent',
          botId: 'b',
          requestedBy: { kind: 'other', channelKind: 'web', address: 'x' },
        })
      )
    ).toBe(false);
  });

  test('old agent jobs without requestedBy: only those created inside a cycle', () => {
    expect(cronJobRunsAsSelf(job({ kind: 'agent', botId: 'b', cycleId: 'c1' }))).toBe(true);
    expect(cronJobRunsAsSelf(job({ kind: 'agent', botId: 'b' }))).toBe(false);
  });

  test('no createdBy at all (jobs from before it existed, skill/external jobs) → no', () => {
    expect(cronJobRunsAsSelf(job())).toBe(false);
  });
});

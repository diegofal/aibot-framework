import { describe, expect, it } from 'bun:test';
import type { CronJob } from '../../../src/cron/types';
import { cronJobToWhy, cronRunToWhy, describeSchedule } from '../../../src/why/builders/cron';
import { WhySchema } from '../../../src/why/types';

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'j1',
    name: 'Morning brief',
    enabled: true,
    createdAtMs: Date.UTC(2026, 9, 11, 12),
    updatedAtMs: Date.UTC(2026, 9, 11, 12),
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'America/Buenos_Aires' },
    payload: { kind: 'instruction', text: 'Send me the news', chatId: 1, botId: 'b1' },
    state: { consecutiveErrors: 0 },
    ...over,
  };
}

const row = {
  cycleId: 'c1',
  startedAt: '2026-10-11T11:59:00Z',
  endedAt: '2026-10-11T12:05:00Z',
  planSummary: 'Set up a daily brief',
  goalId: 'g1',
  goalTitle: 'Keep Diego informed',
};

describe('describeSchedule', () => {
  it('cron expressions in words, with the time zone', () => {
    expect(describeSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe(
      'Every day at 09:00 (UTC)'
    );
  });
  it('every N and one-off schedules', () => {
    expect(describeSchedule({ kind: 'every', everyMs: 30 * 60_000 })).toBe('Every 30 minutes');
    expect(describeSchedule({ kind: 'every', everyMs: 2 * 3_600_000 })).toBe('Every 2 hours');
    expect(describeSchedule({ kind: 'every', everyMs: 86_400_000 })).toBe('Every 1 day');
    expect(describeSchedule({ kind: 'every', everyMs: 1_500 })).toBe('Every 2 seconds');
    expect(describeSchedule({ kind: 'at', at: '2026-10-12T09:00:00Z' })).toBe(
      'Once, at 2026-10-12T09:00:00Z'
    );
  });
});

describe('cronJobToWhy', () => {
  it('a tenant set it up through the API: not "you", not the agent', () => {
    const w = cronJobToWhy({ job: job({ createdBy: { kind: 'tenant', tenantId: 'acme' } }) });
    expect(w.what).toBe('A scheduled job set up through the API');
    expect(w.by).toBeUndefined();
    expect(w.missing).toBeUndefined();
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('an agent made it in a work cycle: the cycle, its plan and goal, the schedule', () => {
    const w = cronJobToWhy({
      job: job({ createdBy: { kind: 'agent', botId: 'b1', cycleId: 'c1', goalId: 'g1' } }),
      cycle: row,
    });
    expect(w.what).toBe('A scheduled job the agent set up');
    expect(w.by).toBe('agent');
    expect(w.cycle).toEqual({
      id: 'c1',
      botId: 'b1',
      startedAt: '2026-10-11T11:59:00Z',
      plan: 'Set up a daily brief',
    });
    expect(w.goal).toEqual({ id: 'g1', title: 'Keep Diego informed' });
    expect(w.rule).toBe('Runs every day at 09:00 (America/Buenos_Aires)');
    expect(w.notes).toEqual([{ label: 'Instruction', text: 'Send me the news' }]);
    expect(w.outcome).toBe('Active; it has not run yet.');
    expect(w.missing).toBeUndefined();
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('an agent made it outside a cycle (a chat): no cycle, said plainly', () => {
    const w = cronJobToWhy({ job: job({ createdBy: { kind: 'agent', botId: 'b1' } }) });
    expect(w.by).toBe('agent');
    expect(w.cycle).toBeUndefined();
    expect(w.missing).toContain('No record of a work cycle');
  });

  it('a recorded cycle missing from the log', () => {
    const w = cronJobToWhy({
      job: job({ createdBy: { kind: 'agent', botId: 'b1', cycleId: 'c9' } }),
    });
    expect(w.cycle).toEqual({ id: 'c9', botId: 'b1' });
    expect(w.missing).toContain('cycle log has no row');
  });

  it('the operator made it on the dashboard', () => {
    const w = cronJobToWhy({ job: job({ createdBy: { kind: 'operator' } }) });
    expect(w.what).toBe('A scheduled job you set up');
    expect(w.by).toBe('operator');
    expect(w.cycle).toBeUndefined();
    expect(w.missing).toBeUndefined();
  });

  it('an old job without createdBy says so', () => {
    const w = cronJobToWhy({
      job: job({
        enabled: false,
        state: { consecutiveErrors: 2, lastStatus: 'error', lastRunAtMs: 1 },
      }),
    });
    expect(w.what).toBe('A scheduled job');
    expect(w.by).toBeUndefined();
    expect(w.outcome).toBe('Paused. Its last run failed (2 errors in a row).');
    expect(w.missing).toBe('Created before jobs recorded who made them, so its origin is unknown.');
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('a skill job names the skill instead of an instruction', () => {
    const w = cronJobToWhy({
      job: job({
        payload: { kind: 'skillJob', skillId: 'reflection', jobId: 'nightly' },
        state: { consecutiveErrors: 0, lastStatus: 'ok', lastRunAtMs: 1 },
      }),
    });
    expect(w.notes).toEqual([{ label: 'Skill job', text: 'reflection / nightly' }]);
    expect(w.outcome).toBe('Active. Its last run went fine.');
  });
});

describe('cronRunToWhy', () => {
  const run = {
    ts: Date.UTC(2026, 9, 11, 9, 0, 3),
    jobId: 'j1',
    action: 'finished' as const,
    status: 'ok' as const,
    output: 'Here is your brief: markets are up.',
    runAtMs: Date.UTC(2026, 9, 11, 9),
    durationMs: 3_200,
    messageId: 'cron-j1-1-abc',
  };

  it('which job, when, and what it produced', () => {
    const w = cronRunToWhy({ run, job: job({ createdBy: { kind: 'operator' } }) });
    expect(w.what).toBe('A run of "Morning brief"');
    expect(w.by).toBe('cron');
    expect(w.rule).toBe('Runs every day at 09:00 (America/Buenos_Aires)');
    expect(w.related).toEqual({
      label: 'Job',
      items: [
        {
          text: 'Morning brief',
          at: '2026-10-11T09:00:00.000Z',
          detail: 'Set up by you',
          href: '#/automations/cron/j1',
        },
      ],
    });
    expect(w.outcome).toBe('Ran fine in 3.2 s. Output: "Here is your brief: markets are up."');
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('a failed run: the error head; a deleted job: said plainly', () => {
    const w = cronRunToWhy({
      run: { ...run, status: 'error', output: undefined, error: 'Error: Pipeline failed' },
    });
    expect(w.what).toBe('A run of a scheduled job');
    expect(w.outcome).toBe('Failed: Error: Pipeline failed');
    expect(w.missing).toBe('The job is gone, so its schedule and origin are unknown.');
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('clips long output', () => {
    const w = cronRunToWhy({ run: { ...run, output: 'x'.repeat(500) }, job: job() });
    expect(w.outcome?.length).toBeLessThan(260);
    expect(w.outcome).toEndWith('…"');
  });
});

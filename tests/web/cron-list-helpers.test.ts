import { describe, expect, it } from 'bun:test';
import {
  apiList,
  bulkTargets,
  cronBulkBar,
  cronErrorState,
  cronTable,
  cronToolbar,
  filterJobs,
  humanSchedule,
  inWords,
  jobAgentId,
  jobRow,
  jobWhySection,
  lastRunCell,
  payloadCell,
  rerunSummary,
  runWhyCell,
  sortJobs,
} from '../../web/pages/cron-list-helpers.js';

const NOW = 1_700_000_000_000;
const H = 3_600_000;

const names = { default: 'AIBot', cryptik: 'cryptik' };

const skillJob = {
  id: 'j1',
  name: 'Self-Reflection: nightly-reflection [cryptik]',
  enabled: true,
  schedule: { kind: 'cron', expr: '30 3 * * *', tz: 'America/Argentina/Buenos_Aires' },
  payload: {
    kind: 'skillJob',
    skillId: 'reflection',
    jobId: 'nightly-reflection',
    botId: 'cryptik',
  },
  state: {
    nextRunAtMs: NOW + 9 * H,
    lastRunAtMs: NOW - 13 * H,
    lastStatus: 'ok',
    lastDurationMs: 138_000,
  },
  createdAtMs: NOW - 30 * H,
};
const instrJob = {
  id: 'j2',
  name: 'Check job boards',
  enabled: false,
  schedule: { kind: 'every', everyMs: 3 * H },
  payload: {
    kind: 'instruction',
    text: 'Check job boards and <message> me',
    chatId: 1,
    botId: 'default',
  },
  state: {
    nextRunAtMs: null,
    lastStatus: 'error',
    lastError: 'boom '.repeat(40),
    lastRunAtMs: NOW - 5 * 60_000,
  },
  createdAtMs: NOW - 30 * H,
};
const fleetJob = {
  id: 'j3',
  name: 'Ping',
  enabled: true,
  schedule: { kind: 'at', at: '2026-01-01T09:00:00Z' },
  payload: { kind: 'message', text: 'hi', chatId: 1 },
  state: {},
  createdAtMs: NOW,
};

describe('jobAgentId', () => {
  it('reads the agent from the payload', () => {
    expect(jobAgentId(skillJob)).toBe('cryptik');
    expect(jobAgentId(fleetJob)).toBeNull();
  });
});

describe('inWords', () => {
  it('inWords gives a relative time in both directions', () => {
    expect(inWords(NOW + 9 * H, NOW)).toBe('in 9h');
    expect(inWords(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(inWords(null, NOW)).toBe('');
  });
});

describe('apiList / cronErrorState', () => {
  it('apiList tells a list from an error object', () => {
    expect(apiList([1, 2])).toEqual({ list: [1, 2], error: null });
    expect(apiList({ error: 'nope' })).toEqual({ list: [], error: 'nope' });
    expect(apiList(null).error).toBeTruthy();
  });
  it('cronErrorState escapes the message and offers Retry', () => {
    const html = cronErrorState('bad <thing>');
    expect(html).toContain('bad &lt;thing&gt;');
    expect(html).toContain('data-action="retry"');
  });
});

describe('rerunSummary', () => {
  it('counts the jobs that ran out of the attempted ones', () => {
    expect(
      rerunSummary({ attempted: 3, results: [{ ran: true }, { ran: false }, { ran: true }] })
    ).toEqual({
      text: 'Re-ran 2/3',
      tone: 'ok',
    });
  });

  it('is danger when nothing ran, or on an error response', () => {
    expect(rerunSummary({ attempted: 1, results: [{ ran: false }] })).toEqual({
      text: 'Re-ran 0/1',
      tone: 'danger',
    });
    expect(rerunSummary({ error: 'nope' })).toEqual({
      text: 'Re-run failed: nope',
      tone: 'danger',
    });
    expect(rerunSummary(null)).toEqual({ text: 'Re-run failed: no response', tone: 'danger' });
  });

  it('copes with a missing results array', () => {
    expect(rerunSummary({ attempted: 0 })).toEqual({ text: 'Re-ran 0/0', tone: 'danger' });
  });
});

describe('Why this? on jobs and runs (Why row 16)', () => {
  const why = {
    what: 'A scheduled job the agent set up',
    by: 'agent',
    cycle: { id: 'c1', botId: 'cryptik', plan: 'Set up a brief' },
    rule: 'Runs every day at 09:00',
  };

  it('the job detail renders the server Why with the shared panel', () => {
    const html = jobWhySection({ ...skillJob, why }, NOW);
    expect(html).toContain('<details class="why">');
    expect(html).toContain('data-open-cycle="c1"');
    expect(html).toContain('Runs every day at 09:00');
    expect(jobWhySection(skillJob, NOW)).toBe('');
  });

  it('each run row gets its own fold cell; an old run without one gets an empty cell', () => {
    const run = { ts: 1, why: { what: 'A run of "Brief"', by: 'cron', outcome: 'Ran fine.' } };
    const cell = runWhyCell(run, NOW);
    expect(cell).toStartWith('<td class="cron-run-why">');
    expect(cell).toContain('<details class="why">');
    expect(cell).toContain('Ran fine.');
    expect(runWhyCell({ ts: 1 }, NOW)).toBe('<td class="cron-run-why"></td>');
  });
});

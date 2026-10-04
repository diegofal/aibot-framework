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
  lastRunCell,
  payloadCell,
  rerunSummary,
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

describe('humanSchedule', () => {
  it('describes a cron expression in words and keeps the expression as detail', () => {
    expect(humanSchedule(skillJob.schedule)).toEqual({
      text: 'Every day at 03:30',
      detail: '30 3 * * * (America/Argentina/Buenos_Aires)',
    });
  });
  it('describes interval and one-shot schedules', () => {
    expect(humanSchedule({ kind: 'every', everyMs: 3 * H }).text).toBe('Every 3h');
    expect(humanSchedule({ kind: 'every', everyMs: 90_000 }).text).toBe('Every 1.5m');
    expect(humanSchedule({ kind: 'at', at: '2026-01-01T09:00:00Z' }).text).toMatch(/^Once at /);
    expect(humanSchedule({ kind: 'weird' }).text).toBe('?');
  });
});

describe('jobAgentId / sortJobs / filterJobs', () => {
  it('reads the agent from the payload', () => {
    expect(jobAgentId(skillJob)).toBe('cryptik');
    expect(jobAgentId(fleetJob)).toBeNull();
  });
  it('sorts by agent name, fleet-wide jobs first, then by job name', () => {
    const ids = sortJobs([skillJob, instrJob, fleetJob], names).map((j) => j.id);
    expect(ids).toEqual(['j3', 'j2', 'j1']);
  });
  it('filters by agent and by free text (name, payload, schedule)', () => {
    const all = [skillJob, instrJob, fleetJob];
    expect(filterJobs(all, { botId: 'cryptik' }).map((j) => j.id)).toEqual(['j1']);
    expect(filterJobs(all, { botId: '__fleet__' }).map((j) => j.id)).toEqual(['j3']);
    expect(filterJobs(all, { query: 'boards' }).map((j) => j.id)).toEqual(['j2']);
    expect(filterJobs(all, { query: 'reflection' }).map((j) => j.id)).toEqual(['j1']);
    expect(filterJobs(all, { query: 'EVERY DAY' }).map((j) => j.id)).toEqual(['j1']);
    expect(filterJobs(all, {})).toHaveLength(3);
  });
});

describe('cells', () => {
  it('inWords gives a relative time in both directions', () => {
    expect(inWords(NOW + 9 * H, NOW)).toBe('in 9h');
    expect(inWords(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(inWords(null, NOW)).toBe('');
  });
  it('payloadCell shows a kind badge and escapes the text', () => {
    expect(payloadCell(skillJob.payload)).toContain('reflection/nightly-reflection');
    const html = payloadCell(instrJob.payload);
    expect(html).toContain('&lt;message&gt;');
    expect(html).not.toContain('<message>');
    expect(html).toContain('ui-badge');
  });
  it('lastRunCell shows the status, the age and a truncated error', () => {
    const ok = lastRunCell(skillJob, NOW);
    expect(ok).toContain('13h ago');
    expect(ok).toContain('2.3m');
    const err = lastRunCell(instrJob, NOW);
    expect(err).toContain('5m ago');
    expect(err).toContain('boom');
    expect(err.length).toBeLessThan(400);
    expect(lastRunCell(fleetJob, NOW)).toContain('never');
  });
});

describe('jobRow / cronTable / cronToolbar', () => {
  it('renders one Run button and a menu with edit, logs, view and delete', () => {
    const row = jobRow(skillJob, { names, nowMs: NOW });
    const html = row.cells.join('');
    expect(row.attrs['data-id']).toBe('j1');
    expect(html).toContain('data-action="run"');
    expect(html).toContain('data-action="edit"');
    expect(html).toContain('data-action="logs"');
    expect(html).toContain('href="#/automations/cron/j1"');
    expect(html).toContain('data-action="delete"');
    expect(html).toContain('cryptik');
    expect(html).toContain('Every day at 03:30');
    expect(html).toContain('title="30 3 * * *');
    expect(html).toContain('data-action="toggle"');
    expect(html).toContain('in 9h');
  });
  it('strips the "[botId]" suffix from the job name when the agent chip already says it', () => {
    const html = jobRow(skillJob, { names, nowMs: NOW }).cells[0];
    expect(html).not.toContain('[cryptik]');
    expect(html).toContain('Self-Reflection: nightly-reflection');
  });
  it('marks disabled jobs and errored jobs on the row', () => {
    const row = jobRow(instrJob, { names, nowMs: NOW });
    expect(row.attrs.class).toContain('cron-row-off');
    expect(row.attrs.class).toContain('cron-row-error');
  });
  it('cronTable renders sorted rows and an empty state for a filtered-out list', () => {
    const html = cronTable([skillJob, fleetJob], { names, nowMs: NOW });
    expect(html).toContain('<tbody id="cron-tbody">');
    expect(html.indexOf('data-id="j3"')).toBeLessThan(html.indexOf('data-id="j1"'));
    expect(cronTable([], { names, nowMs: NOW, filtered: true })).toContain('No jobs match');
    expect(cronTable([], { names, nowMs: NOW })).toContain('No cron jobs yet');
  });
  it('cronToolbar offers an agent filter with counts and a search box', () => {
    const html = cronToolbar({
      agents: [
        { id: 'default', name: 'AIBot' },
        { id: 'cryptik', name: 'cryptik' },
      ],
      jobs: [skillJob, instrJob, fleetJob],
      botId: 'cryptik',
      query: 'x"y',
    });
    expect(html).toContain('id="cron-filter-agent"');
    expect(html).toContain('<option value="">All agents (3)</option>');
    expect(html).toContain('value="cryptik" selected>cryptik (1)');
    expect(html).toContain('value="__fleet__">Fleet-wide (1)');
    expect(html).toContain('id="cron-filter-query"');
    expect(html).toContain('value="x&quot;y"');
  });
});

describe('UX overhaul: sorting, selection, bulk and error states', () => {
  const all = [skillJob, instrJob, fleetJob];
  it('sortJobs by name ignores the agent grouping', () => {
    expect(sortJobs(all, names, 'name').map((j) => j.id)).toEqual(['j2', 'j3', 'j1']);
  });
  it('sortJobs by next run puts the soonest first and paused/unknown last', () => {
    const soon = { ...fleetJob, id: 'j4', state: { nextRunAtMs: NOW + H } };
    const ids = sortJobs([instrJob, skillJob, fleetJob, soon], names, 'next').map((j) => j.id);
    expect(ids.slice(0, 2)).toEqual(['j4', 'j1']);
    expect(ids.slice(2).sort()).toEqual(['j2', 'j3']);
  });
  it('cronTable honours sortBy and renders a select checkbox per row when selectable', () => {
    const html = cronTable(all, {
      names,
      nowMs: NOW,
      sortBy: 'name',
      selectable: true,
      selected: new Set(['j1']),
    });
    expect(html.indexOf('data-id="j2"')).toBeLessThan(html.indexOf('data-id="j1"'));
    expect(html).toContain('data-select="j1" checked');
    expect(html).toContain('data-select="j2"');
    expect(html).not.toContain('data-select="j2" checked');
  });
  it('cronToolbar marks the search box as the page filter and offers a sort select', () => {
    const html = cronToolbar({ agents: [], jobs: all, sortBy: 'next' });
    expect(html).toContain('data-page-filter');
    expect(html).toContain('id="cron-sort"');
    expect(html).toContain('value="next" selected');
    expect(html).toContain('id="cron-select-all"');
  });
  it('cronBulkBar is empty with nothing selected and offers the four bulk actions otherwise', () => {
    expect(cronBulkBar(0)).toBe('');
    const html = cronBulkBar(3);
    expect(html).toContain('3 selected');
    for (const a of ['pause', 'resume', 'run', 'delete'])
      expect(html).toContain(`data-bulk="${a}"`);
  });
  it('bulkTargets keeps only the jobs an action would change', () => {
    const ids = new Set(['j1', 'j2', 'j3']);
    expect(bulkTargets(all, ids, 'pause').map((j) => j.id)).toEqual(['j1', 'j3']);
    expect(bulkTargets(all, ids, 'resume').map((j) => j.id)).toEqual(['j2']);
    expect(bulkTargets(all, ids, 'delete')).toHaveLength(3);
    expect(bulkTargets(all, new Set(['j1']), 'run').map((j) => j.id)).toEqual(['j1']);
  });
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
    expect(rerunSummary({ attempted: 3, results: [{ ran: true }, { ran: false }, { ran: true }] })).toEqual({
      text: 'Re-ran 2/3',
      tone: 'ok',
    });
  });

  it('is danger when nothing ran, or on an error response', () => {
    expect(rerunSummary({ attempted: 1, results: [{ ran: false }] })).toEqual({
      text: 'Re-ran 0/1',
      tone: 'danger',
    });
    expect(rerunSummary({ error: 'nope' })).toEqual({ text: 'Re-run failed: nope', tone: 'danger' });
    expect(rerunSummary(null)).toEqual({ text: 'Re-run failed: no response', tone: 'danger' });
  });

  it('copes with a missing results array', () => {
    expect(rerunSummary({ attempted: 0 })).toEqual({ text: 'Re-ran 0/0', tone: 'danger' });
  });
});

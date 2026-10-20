import { describe, expect, it } from 'bun:test';
import {
  FLEET_GROUP,
  agentColor,
  agentOrder,
  attentionHtml,
  chipsHtml,
  drawerHtml,
  failureWords,
  filterBoard,
  groupsHtml,
  jobRowHtml,
  jobTitle,
  runDuration,
  scheduleWords,
  tzLabel,
  weekDays,
  weekHtml,
} from '../../web/pages/cron-board-helpers.js';

const H = 3_600_000;
const D = 24 * H;
// Local midnight so day buckets do not depend on the machine's timezone.
const MIDNIGHT = new Date(2026, 9, 16).getTime();
const NOW = MIDNIGHT + 7 * H;
const BA = 'America/Argentina/Buenos_Aires';
const names = { 'ai-perfectionist': 'AI Perfectionist', 'job-seeker': 'job-seeker' };

const reflection = {
  id: 'r1',
  name: 'Self-Reflection: nightly-reflection [ai-perfectionist]',
  enabled: true,
  schedule: { kind: 'cron', expr: '30 3 * * 0', tz: BA },
  payload: {
    kind: 'skillJob',
    skillId: 'reflection',
    jobId: 'nightly-reflection',
    botId: 'ai-perfectionist',
  },
  state: {
    nextRunAtMs: NOW + 45 * H,
    lastRunAtMs: NOW - 5 * D,
    lastStatus: 'ok',
    lastDurationMs: 77_057,
  },
  upcoming: [NOW + 45 * H],
};
const brief = {
  id: 'b1',
  name: 'Weekly roles shortlist [job-seeker]',
  enabled: true,
  schedule: { kind: 'cron', expr: '0 9 * * 1', tz: BA },
  payload: {
    kind: 'instruction',
    text: "It's Monday: build this week's roles shortlist.\nMore",
    botId: 'job-seeker',
  },
  state: { nextRunAtMs: NOW + 3 * D },
  upcoming: [NOW + 3 * D],
};
const failed = {
  id: 'f1',
  name: 'Deliver 09 portability seam finding',
  enabled: false,
  schedule: { kind: 'at', at: '2026-09-26T23:56:30.000Z' },
  payload: { kind: 'message', text: 'Ran a real probe', botId: 'ai-perfectionist' },
  state: {
    lastRunAtMs: NOW - 19 * D,
    lastStatus: 'error',
    lastError: 'Error: Bot not found: ai-perfectionist',
    lastDurationMs: 1,
  },
};
const paused = {
  ...reflection,
  id: 'p1',
  name: 'Intelligence Gatherer: daily-intel-collection [ai-perfectionist]',
  enabled: false,
  upcoming: [],
};
const fleet = {
  id: 'x1',
  name: 'Fleet sweep',
  enabled: true,
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  payload: { kind: 'message', text: 'hi', chatId: 1 },
  state: {},
};
const ALL = [reflection, brief, failed, paused];

describe('words', () => {
  it('jobTitle: skill jobs read as the skill plus the job, no [agent] suffix', () => {
    expect(jobTitle(reflection)).toEqual({ title: 'Reflection', sub: 'nightly reflection' });
    expect(jobTitle(paused)).toEqual({ title: 'Intel gathering', sub: 'daily intel collection' });
    expect(jobTitle(brief)).toEqual({ title: 'Weekly roles shortlist', sub: '' });
    expect(jobTitle({ name: 'Report: weekly-sum', payload: {} })).toEqual({
      title: 'Report',
      sub: 'weekly sum',
    });
  });

  it('tzLabel', () => {
    expect(tzLabel(BA)).toBe('Buenos Aires time');
    expect(tzLabel('UTC')).toBe('UTC');
    expect(tzLabel(undefined)).toBe('server time');
  });

  it('scheduleWords: an interval that is not whole minutes is not rounded to one', () => {
    expect(scheduleWords({ kind: 'every', everyMs: 500 }).text).toBe('Every 500ms');
    expect(scheduleWords({ kind: 'every', everyMs: 1500 }).text).toBe('Every 1.5s');
    expect(scheduleWords({ kind: 'every', everyMs: 30_000 }).text).toBe('Every 30s');
    expect(scheduleWords({ kind: 'every', everyMs: 90_000 }).text).toBe('Every 90s');
    expect(scheduleWords({ kind: 'every', everyMs: 5 * 60_000 }).text).toBe('Every 5m');
  });

  it('scheduleWords: cron, every and once', () => {
    expect(scheduleWords({ kind: 'cron', expr: '0 9 * * *' })).toEqual({
      text: 'Daily at 09:00',
      tz: 'server time',
    });
    expect(scheduleWords(reflection.schedule)).toEqual({
      text: 'Sundays at 03:30',
      tz: 'Buenos Aires time',
    });
    const anchor = new Date(2026, 9, 19, 9).getTime(); // a Monday, 09:00 local
    expect(scheduleWords({ kind: 'every', everyMs: 14 * D, anchorMs: anchor }).text).toBe(
      'Every other Monday'
    );
    expect(scheduleWords({ kind: 'every', everyMs: 14 * D, anchorMs: anchor }).tz).toStartWith(
      '09:00 · '
    );
    expect(scheduleWords({ kind: 'every', everyMs: 2 * H }).text).toBe('Every 2h');
    expect(scheduleWords(failed.schedule).text).toBe('Once');
  });

  it('runDuration', () => {
    expect(runDuration(2)).toBe('2ms');
    expect(runDuration(19_347)).toBe('19s');
    expect(runDuration(77_057)).toBe('1.3m');
  });

  it('failureWords: a headless delivery failure is explained and marked fixed', () => {
    const w = failureWords(failed, names);
    expect(w.text).toContain('AI Perfectionist has no Telegram connection');
    expect(w.fixed).toContain('Run it again');
    expect(failureWords({ state: { lastError: 'Error: boom' } })).toEqual({
      text: 'boom',
      fixed: '',
    });
  });

  it('agentColor is stable per agent; fleet is neutral', () => {
    expect(agentColor('job-seeker')).toBe(agentColor('job-seeker'));
    expect(agentColor('job-seeker')).toMatch(/^hsl\(\d+ 70% 72%\)$/);
    expect(agentColor(FLEET_GROUP)).toBe('var(--text-dim)');
  });
});

describe('filter and order', () => {
  it('filterBoard by state, agent and text', () => {
    const ids = (f: object) => filterBoard(ALL, { names, ...f }).map((j) => j.id);
    expect(ids({ filter: 'on' })).toEqual(['r1', 'b1']);
    expect(ids({ filter: 'paused' })).toEqual(['f1', 'p1']);
    expect(ids({ filter: 'failed' })).toEqual(['f1']);
    expect(ids({ filter: 'a:job-seeker' })).toEqual(['b1']);
    expect(ids({ query: 'perfectionist' })).toEqual(['r1', 'f1', 'p1']);
    expect(ids({ query: 'shortlist' })).toEqual(['b1']);
  });

  it('agentOrder: by name, fleet last', () => {
    expect(agentOrder([fleet, brief, reflection], names)).toEqual([
      'ai-perfectionist',
      'job-seeker',
      FLEET_GROUP,
    ]);
  });
});

describe('chips', () => {
  it('counts every state and agent; the active filter is on; Failed only when there are failures', () => {
    const html = chipsHtml(ALL, { filter: 'paused', names });
    expect(html).toContain('All <b>4</b>');
    expect(html).toContain('On <b>2</b>');
    expect(html).toMatch(/cj-chip on" data-f="paused"/);
    expect(html).toContain('Failed <b>1</b>');
    expect(html).toContain('AI Perfectionist <b>3</b>');
    expect(chipsHtml([brief], { names })).not.toContain('Failed');
    expect(html).toContain('data-page-filter');
  });
});

describe('week', () => {
  it('weekDays: each upcoming run on its local day; paused jobs and runs past the week left out', () => {
    const late = { ...brief, id: 'late', upcoming: [MIDNIGHT + 8 * D] };
    const days = weekDays([reflection, brief, paused, late], NOW);
    expect(days).toHaveLength(7);
    // NOW is 07:00 day 0: +45h lands on day 2 at 04:00, +3d on day 3.
    expect(days.map((d) => d.events.map((e) => e.job.id))).toEqual([
      [],
      [],
      ['r1'],
      ['b1'],
      [],
      [],
      [],
    ]);
  });

  it('weekHtml: Today first, the total, a dash on empty days', () => {
    const html = weekHtml([brief], { nowMs: NOW });
    expect(html).toContain('1 run scheduled');
    expect(html).toContain('>Today<');
    expect(html).toContain('>Tomorrow<');
    expect(html).toContain('data-open="b1"');
    expect(html).toContain('cj-none');
  });
});

describe('attention', () => {
  it('lists failed jobs with the reason, the raw error and the actions; empty when none failed', () => {
    const html = attentionHtml(ALL, { names, nowMs: NOW });
    expect(html).toContain('Needs attention');
    expect(html).toContain('Deliver 09 portability seam finding');
    expect(html).toContain('failed 19d ago');
    expect(html).toContain('<code>Bot not found: ai-perfectionist</code>');
    expect(html).toContain('data-run="f1"');
    expect(html).toContain('data-del="f1"');
    expect(attentionHtml([brief], { names })).toBe('');
  });
});

describe('rows and groups', () => {
  it('a row: kind, clean title, first line of what it does, schedule, next and last run', () => {
    const html = jobRowHtml(brief, { nowMs: NOW });
    expect(html).toContain('cj-k-instruction');
    expect(html).toContain('Weekly roles shortlist');
    expect(html).toContain('build this week&#39;s roles shortlist.');
    expect(html).not.toContain('Second line');
    expect(html).toContain('Mondays at 09:00');
    expect(html).toContain('next in 3d');
    expect(html).toContain('never ran');
    expect(html).toContain('cj-tg on');
  });

  it('a paused one-shot that ran reads done; a failed one says failed', () => {
    const html = jobRowHtml(failed, { nowMs: NOW });
    expect(html).toContain('>done<');
    expect(html).toContain('failed 19d ago · 1ms');
    expect(html).toContain('cj-job off');
  });

  it('groups by agent; paused ones folded unless a group has nothing on or a filter shows them', () => {
    const html = groupsHtml(ALL, { names, nowMs: NOW });
    expect(html.indexOf('AI Perfectionist')).toBeLessThan(html.indexOf('job-seeker'));
    expect(html).toContain('2 paused</button>');
    expect(html).not.toContain('data-id="p1"');
    expect(groupsHtml(ALL, { names, nowMs: NOW, open: new Set(['ai-perfectionist']) })).toContain(
      'data-id="p1"'
    );
    expect(groupsHtml(ALL, { names, nowMs: NOW, filter: 'paused' })).toContain('data-id="p1"');
    expect(groupsHtml([paused], { names, nowMs: NOW })).toContain('data-id="p1"');
    expect(groupsHtml(ALL, { names, query: 'zzz' })).toContain('No jobs match');
    // "Show all" clears the search too, not only the filter chip.
    expect(groupsHtml(ALL, { names, query: 'zzz' })).toContain('data-show-all');
    expect(groupsHtml([], {})).toContain('No cron jobs yet');
  });

  it('a fleet job groups under Fleet, without an agent link', () => {
    const html = groupsHtml([fleet], { names, nowMs: NOW });
    expect(html).toContain('<h3>Fleet</h3>');
  });
});

describe('drawer', () => {
  it('when, next run, the failure in words, what it sends, recent runs and the actions', () => {
    const job = {
      ...failed,
      runs: [
        {
          ts: NOW - 20 * D,
          runAtMs: NOW - 20 * D,
          action: 'finished',
          status: 'ok',
          output: 'Sent',
        },
        {
          ts: NOW - 19 * D,
          runAtMs: NOW - 19 * D,
          action: 'finished',
          status: 'error',
          error: 'Bot not found',
        },
      ],
    };
    const html = drawerHtml(job, { names, nowMs: NOW });
    expect(html).toContain('cj-pill err');
    expect(html).toContain('Already ran');
    expect(html).toContain('Last run failed 19d ago');
    expect(html).toContain('>Sends<');
    expect(html.indexOf('19d ago')).toBeLessThan(html.indexOf('20d ago'));
    expect(html).toContain('data-run="f1"');
    expect(html).toContain('data-edit="f1"');
    expect(html).toContain('href="#/automations/cron/f1"');
    expect(drawerHtml(null)).toBe('');
  });

  it('a job that never ran says so', () => {
    expect(drawerHtml(brief, { names, nowMs: NOW })).toContain('Has not run yet.');
  });
});

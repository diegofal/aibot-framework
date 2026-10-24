import { describe, expect, test } from 'bun:test';
import { logRowHtml, stateHtml, stateParts } from '../../web/pages/watcher-helpers.js';
import {
  embeddingStatusHtml,
  graphCleanSummary,
  isPassRow,
  matchPassRecord,
  passFoldHtml,
  passRecordBodyHtml,
} from '../../web/pages/watcher-ops-helpers.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const row = {
  ts: '2026-10-24T11:00:02.000Z',
  seq: 7,
  phase: 'notice',
  op: 'notice:pass',
  text: 'I looked at 4 events.',
  source: 'watcher:notice',
  model: 'claude-haiku-5-5',
  tokens: 900,
  durationMs: 1200,
};
const rec = (over = {}) => ({
  id: 'notice-1761303601000-ab12',
  caller: 'watcher:notice',
  endedAt: '2026-10-24T11:00:01.000Z',
  durationMs: 1200,
  ok: true,
  ...over,
});

describe('isPassRow', () => {
  test('a row of a model call (watcher source + duration) is a pass row', () => {
    expect(isPassRow(row)).toBe(true);
    expect(isPassRow({ ...row, durationMs: undefined })).toBe(false);
    expect(isPassRow({ ...row, source: 'activity' })).toBe(false);
    expect(isPassRow(null)).toBe(false);
  });
});

describe('matchPassRecord', () => {
  test('same caller and duration, ended just before the row; the closest wins', () => {
    const older = rec({ id: 'notice-1761303000000-0001', endedAt: '2026-10-24T10:50:00.000Z' });
    const right = rec();
    expect(matchPassRecord(row, [older, right])?.id).toBe(right.id);
  });

  test('another caller, another duration, or too far apart → none', () => {
    expect(matchPassRecord(row, [rec({ caller: 'watcher:integrate' })])).toBeNull();
    expect(matchPassRecord(row, [rec({ durationMs: 1201 })])).toBeNull();
    expect(matchPassRecord(row, [rec({ endedAt: '2026-10-24T10:00:00.000Z' })])).toBeNull();
    expect(matchPassRecord(row, [rec({ endedAt: '2026-10-24T11:00:30.000Z' })])).toBeNull();
    expect(matchPassRecord({ ...row, source: 'x' }, [rec()])).toBeNull();
  });
});

describe('pass fold', () => {
  test('closed: a "What it saw" summary only; open: the body inside', () => {
    const closed = passFoldHtml(row, null);
    expect(closed).toContain('What it saw');
    expect(closed).toContain('data-action="watcher-pass"');
    expect(closed).toContain('data-seq="7"');
    expect(closed).not.toContain(' open');
    const open = passFoldHtml(row, '<p>body</p>');
    expect(open).toContain('<details class="watcher-pass" open>');
    expect(open).toContain('<p>body</p>');
  });

  test('the body shows system, prompt and response escaped; a failed call its error', () => {
    const html = passRecordBodyHtml({
      ...rec(),
      prompt: { system: 'You are <the> watcher', user: '- [i-1] event' },
      response: '{"keep":[]}',
    });
    expect(html).toContain('You are &lt;the&gt; watcher');
    expect(html).toContain('- [i-1] event');
    expect(html).toContain('What it said');
    expect(html).toContain('{&quot;keep&quot;:[]}');
    const failed = passRecordBodyHtml({
      ...rec(),
      ok: false,
      error: 'boom',
      prompt: { system: '', user: 'u' },
    });
    expect(failed).toContain('boom');
    expect(passRecordBodyHtml(null)).toContain('No record');
  });

  test('logRowHtml adds the fold to pass rows only, open for the open seq', () => {
    expect(logRowHtml(row, NOW)).toContain('watcher-pass');
    expect(logRowHtml({ ...row, source: undefined }, NOW)).not.toContain('watcher-pass');
    expect(logRowHtml(row, NOW, { openPass: { seq: 7, html: '<i>x</i>' } })).toContain('<i>x</i>');
    expect(logRowHtml(row, NOW, { openPass: { seq: 8, html: '<i>x</i>' } })).not.toContain(
      '<i>x</i>'
    );
  });

  test('never renders a Why fold of its own', () => {
    expect(passFoldHtml(row, '<p/>')).not.toMatch(/class="why[" -]/);
  });
});

describe('embeddingStatusHtml', () => {
  test('ok, down since, not configured, unknown', () => {
    expect(
      embeddingStatusHtml({ ok: true, model: 'nomic', latencyMs: 12, downSince: null }, NOW)
    ).toContain('embeddings: ok');
    const down = embeddingStatusHtml(
      {
        ok: false,
        model: 'nomic',
        latencyMs: 3,
        downSince: '2026-10-24T09:00:00.000Z',
        error: 'connect ECONNREFUSED',
      },
      NOW
    );
    expect(down).toContain('embeddings: down since 3 h ago');
    expect(down).toContain('is-error');
    expect(down).toContain('ECONNREFUSED');
    expect(embeddingStatusHtml({ ok: false, model: null, downSince: null }, NOW)).toContain(
      'not configured'
    );
    expect(embeddingStatusHtml(null, NOW)).toBe('');
  });

  test('the state bar carries it when given', () => {
    const embedding = { ok: true, model: 'nomic', latencyMs: 5, downSince: null };
    expect(stateParts({ running: true }, NOW, { embedding }).embed).toContain('embeddings: ok');
    expect(stateHtml({ running: true }, NOW, { embedding })).toContain('watcher-embed');
    expect(stateParts({ running: true }, NOW).embed).toBe('');
  });
});

describe('graphCleanSummary', () => {
  const f = (kind, n = 1) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${kind}${i}`,
      kind,
      fixable: kind !== 'graph-summary',
      data: kind === 'duplicate-facts' ? { dropIds: ['a', 'b'] } : {},
    }));
  test('a preview says what would change; nothing to do says so', () => {
    const preview = {
      dryRun: true,
      findings: [...f('date-header-fact', 2), ...f('bookkeeping-fact'), ...f('duplicate-facts')],
      applied: [],
    };
    expect(graphCleanSummary(preview)).toBe(
      'Would archive 3 facts (2 date headers, 1 bookkeeping line) and merge 2 near-duplicates in 1 group.'
    );
    expect(graphCleanSummary({ dryRun: true, findings: f('graph-summary'), applied: [] })).toBe(
      'Nothing to clean.'
    );
  });

  test('an apply says what changed; an error or a stopped watcher says that', () => {
    const run = {
      dryRun: false,
      findings: [],
      applied: [{ action: 'archive' }, { action: 'archive' }, { action: 'merge' }],
      skipped: [{}],
    };
    expect(graphCleanSummary(run)).toBe(
      'Archived 2 facts, merged 1 group. 1 skipped (changed since the preview).'
    );
    expect(graphCleanSummary({ error: 'boom' })).toBe('The cleanup failed: boom');
    expect(
      graphCleanSummary({ dryRun: true, findings: f('watcher-unavailable'), applied: [] })
    ).toContain('not enabled');
  });
});

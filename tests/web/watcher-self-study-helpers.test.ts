import { describe, expect, it } from 'bun:test';
import {
  ARM_MS,
  SELF_STUDY_KEY,
  armClick,
  inText,
  isSelfStudyRow,
  selfStudyCardHtml,
  selfStudyOutcomeText,
} from '../../web/pages/watcher-autonomy-helpers.js';
import { PASS_SOURCES } from '../../web/pages/watcher-ops-helpers.js';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function status(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    running: false,
    lastRunAt: iso(NOW - 2 * H),
    lastOutcome: {
      at: iso(NOW - 2 * H),
      trigger: 'manual',
      status: 'done',
      findings: [],
      proposed: [{ id: 'p-1', title: 'a', status: 'pending' }],
      dropped: [{ title: 'b', why: 'x' }],
      rejected: [],
      costUsd: 0.031,
    },
    nextRunAt: iso(NOW + 5 * 24 * H),
    notes: '# Self-study notes\n\n<script>alert(1)</script>',
    ...over,
  };
}

describe('Self-study card', () => {
  it('is empty unless both switches are on', () => {
    expect(selfStudyCardHtml(null)).toBe('');
    expect(selfStudyCardHtml({ enabled: false })).toBe('');
    expect(selfStudyCardHtml(status(), { nowMs: NOW })).toContain('Self-study');
  });

  it('shows last and next run, the outcome and the notes escaped', () => {
    const html = selfStudyCardHtml(status(), { nowMs: NOW });
    expect(html).toContain('last run 2 h ago · next in 5 d');
    expect(html).toContain('Last outcome: done: 1 proposed, 1 dropped by code · cost $0.03');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('data-action="self-study-run"');
    expect(html).toContain('>Run now<');
  });

  it('never ran and no notes', () => {
    const html = selfStudyCardHtml(status({ lastRunAt: null, lastOutcome: null, notes: null }), {
      nowMs: NOW,
    });
    expect(html).toContain('it has not run yet');
    expect(html).toContain('No notes yet.');
  });

  it('Run now is two-step and disabled while running', () => {
    const { armed } = armClick(null, SELF_STUDY_KEY, NOW);
    expect(selfStudyCardHtml(status(), { nowMs: NOW, ui: { armed } })).toContain(
      'Click again to run'
    );
    expect(selfStudyCardHtml(status(), { nowMs: NOW + ARM_MS + 1, ui: { armed } })).toContain(
      '>Run now<'
    );
    const running = selfStudyCardHtml(status({ running: true }), { nowMs: NOW, ui: { armed } });
    expect(running).toContain('disabled');
    expect(running).toContain('Running…');
    expect(running).toContain('running now');
    expect(selfStudyCardHtml(status(), { nowMs: NOW, ui: { busy: true } })).toContain('disabled');
  });

  it('an error shows inline', () => {
    const html = selfStudyCardHtml(status(), { nowMs: NOW, ui: { error: 'The hard kill is on' } });
    expect(html).toContain('role="alert"');
    expect(html).toContain('The hard kill is on');
  });

  it('outcome words for skipped and failed', () => {
    expect(selfStudyOutcomeText({ status: 'skipped', reason: 'the hard kill is on' })).toBe(
      'skipped: the hard kill is on'
    );
    expect(selfStudyOutcomeText(null)).toBe('');
  });

  it('inText and the row test', () => {
    expect(inText(iso(NOW + 30_000), NOW)).toBe('due now');
    expect(inText(iso(NOW + 30 * 60_000), NOW)).toBe('in 30 min');
    expect(inText(iso(NOW + 3 * H), NOW)).toBe('in 3 h');
    expect(isSelfStudyRow({ op: 'self-study:run' })).toBe(true);
    expect(isSelfStudyRow({ op: 'autonomy:proposed' })).toBe(false);
  });

  it('a self-study row matches its pass record ("What it saw")', () => {
    expect(PASS_SOURCES).toContain('watcher:self-study');
  });
});

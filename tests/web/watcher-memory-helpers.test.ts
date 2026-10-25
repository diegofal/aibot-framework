import { describe, expect, test } from 'bun:test';
import { stateParts } from '../../web/pages/watcher-helpers.js';
import {
  effectRedrawsThoughts,
  memoryCountsHtml,
  summaryRowsHtml,
} from '../../web/pages/watcher-memory-helpers.js';
import { PASS_SOURCES } from '../../web/pages/watcher-ops-helpers.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');

const neuron = (over: Record<string, unknown>) => ({
  id: 'n-00000001',
  kind: 'fact',
  text: 'a fact',
  support: { bots: ['b1'] },
  createdBy: 'watcher',
  createdAt: '2026-10-24T04:00:00Z',
  lastActivatedAt: '2026-10-24T04:00:00Z',
  activations: 0,
  ...over,
});

describe('memoryCountsHtml', () => {
  test('live and archived counts', () => {
    const html = memoryCountsHtml({ counts: { fact: 3, topic: 2 }, archived: 1200 });
    expect(html).toContain('<b>5</b> live');
    expect(html).toContain('<b>1,200</b> archived');
  });

  test('nothing when the state predates the archived count', () => {
    expect(memoryCountsHtml({ counts: { fact: 3 } })).toBe('');
    expect(memoryCountsHtml(null)).toBe('');
  });

  test('the state bar shows it', () => {
    const parts = stateParts({ running: true, counts: { fact: 3 }, archived: 4, edges: 1 }, NOW);
    expect(parts.counts).toContain('<b>4</b> archived');
  });
});

describe('summaryRowsHtml', () => {
  test('live summaries newest first, with their facts in a fold', () => {
    const members = [
      neuron({ id: 'n-m1', text: 'deploy 1 failed', archivedAt: '2026-10-24T04:00:00Z' }),
      neuron({ id: 'n-m2', text: 'deploy 2 <failed>', archivedAt: '2026-10-24T04:00:00Z' }),
    ];
    const older = neuron({
      id: 'n-s1',
      kind: 'summary',
      text: 'older summary',
      createdAt: '2026-10-20T04:00:00Z',
      meta: { consolidated: 'true', members: 'n-m1' },
    });
    const newer = neuron({
      id: 'n-s2',
      kind: 'summary',
      text: 'Deploys failed on a stale cache',
      support: { bots: ['b1', 'b2'] },
      meta: { consolidated: 'true', members: 'n-m1,n-m2,n-gone' },
    });
    const html = summaryRowsHtml([older, ...members, newer], NOW);
    expect(html.indexOf('n-s2')).toBeLessThan(html.indexOf('n-s1'));
    expect(html).toContain('data-watcher-neuron="n-s2"');
    expect(html).toContain('<summary>3 facts</summary>');
    expect(html).toContain('deploy 2 &lt;failed&gt;');
    expect(html).toContain('data-watcher-neuron="n-m1"');
    // a member the page does not hold is named by id
    expect(html).toContain('n-gone');
    expect(html).toContain('b1, b2');
  });

  test('archived summaries are left out; nothing yet says so', () => {
    const gone = neuron({ kind: 'summary', archivedAt: '2026-10-24T05:00:00Z' });
    expect(summaryRowsHtml([gone], NOW)).toContain('No summaries yet');
    expect(summaryRowsHtml(undefined, NOW)).toContain('No summaries yet');
  });
});

test('consolidation calls are pass rows ("What it saw")', () => {
  expect(PASS_SOURCES).toContain('watcher:consolidate');
});

test('archiving a summary (or an insight) redraws the lists, so it leaves the live Summaries', () => {
  const summary = { id: 'n-s', kind: 'summary' };
  expect(effectRedrawsThoughts({ kind: 'archive', id: 'n-s' }, summary)).toBe(true);
  expect(effectRedrawsThoughts({ kind: 'spawn', id: 'n-s' }, summary)).toBe(true);
  expect(effectRedrawsThoughts({ kind: 'update', id: 'n-s' }, summary)).toBe(true);
  expect(effectRedrawsThoughts({ kind: 'archive', id: 'n-i' }, { kind: 'insight' })).toBe(true);
  expect(effectRedrawsThoughts({ kind: 'spawn', id: 'n-f' }, { kind: 'fact' })).toBe(false);
  expect(effectRedrawsThoughts({ kind: 'layout' }, summary)).toBe(false);
  expect(effectRedrawsThoughts({ kind: 'archive', id: 'n-x' }, undefined)).toBe(false);
  // after the archive the list no longer shows it
  const archived = { ...summary, text: 'gone', archivedAt: '2026-10-24T05:00:00Z' };
  expect(summaryRowsHtml([archived], Date.parse('2026-10-25T00:00:00Z'))).not.toContain('n-s');
});

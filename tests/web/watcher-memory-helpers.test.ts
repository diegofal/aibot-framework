import { describe, expect, test } from 'bun:test';
import { stateParts } from '../../web/pages/watcher-helpers.js';
import {
  memoryCountsHtml,
  summaryMemberIds,
  summaryMembersHtml,
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

describe('summaryMembersHtml', () => {
  test('each member the page holds opens it; one it does not is named by id', () => {
    const m1 = neuron({
      id: 'n-m1',
      text: 'deploy 2 <failed>',
      archivedAt: '2026-10-24T04:00:00Z',
    });
    const summary = neuron({
      id: 'n-s',
      kind: 'summary',
      meta: { consolidated: 'true', members: 'n-m1, n-gone,' },
    });
    expect(summaryMemberIds(summary)).toEqual(['n-m1', 'n-gone']);
    const html = summaryMembersHtml(summary, (id: string) => (id === 'n-m1' ? m1 : null));
    expect(html).toContain('data-mind-open="n-m1"');
    expect(html).toContain('deploy 2 &lt;failed&gt;');
    expect(html).toContain('<li class="text-dim">n-gone</li>');
  });

  test('no members, no list', () => {
    expect(summaryMembersHtml(neuron({ kind: 'summary' }))).toBe('');
    expect(summaryMemberIds(null)).toEqual([]);
  });
});

test('consolidation calls are pass rows ("What it saw")', () => {
  expect(PASS_SOURCES).toContain('watcher:consolidate');
});

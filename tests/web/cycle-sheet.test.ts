import { describe, expect, it } from 'bun:test';
import {
  cycleDetailUrl,
  cycleSheetBody,
  cycleSheetMessage,
} from '../../web/pages/cycle-sheet-helpers.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');

const detail = (over: Record<string, unknown> = {}) => ({
  botId: 'b1',
  generatedAt: '2026-10-11T12:00:00Z',
  goal: { id: 'g-1', title: 'Find <remote> roles' },
  cycle: {
    cycleId: 'c-1',
    startedAt: '2026-10-11T11:00:00Z',
    endedAt: '2026-10-11T11:01:00Z',
    durationMs: 60_000,
    status: 'completed',
    focus: null,
    planSummary: 'Search FDE roles',
    attribution: 'exact',
    reason: 'cycle log',
    llmCalls: [],
    toolCalls: [
      { ts: 'x', name: 'web_search', ok: true, failureKind: null, args: '{}', result: 'ok' },
    ],
    productions: [],
    asks: [],
    karma: [],
  },
  ...over,
});

describe('cycle sheet', () => {
  it('builds the API url, escaping ids', () => {
    expect(cycleDetailUrl('b 1', 'c/1')).toBe('/api/agents/b%201/cycles/c%2F1');
  });

  it('shows when, status, the goal (linked) and what the cycle did', () => {
    const html = cycleSheetBody(detail(), NOW);
    expect(html).toContain('completed');
    expect(html).toContain('Find &lt;remote&gt; roles');
    expect(html).toContain('href="#/agents/b1"');
    expect(html).toContain('Search FDE roles');
    expect(html).toContain('web_search');
  });

  it('says so when the cycle recorded no goal', () => {
    expect(cycleSheetBody(detail({ goal: null }), NOW)).toContain('No goal recorded');
  });

  it('messages are escaped', () => {
    expect(cycleSheetMessage('<x>')).toContain('&lt;x&gt;');
  });
});

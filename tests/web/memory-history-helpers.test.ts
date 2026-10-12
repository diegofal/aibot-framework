import { describe, expect, it } from 'bun:test';
import {
  MEMORY_HISTORY_LIMIT,
  memoryHistoryBody,
  memoryHistoryRow,
  memoryHistoryUrl,
} from '../../web/pages/memory-history-helpers.js';

const NOW = Date.parse('2026-10-11T18:00:00Z');

const ev = (over: Record<string, unknown> = {}) => ({
  ts: '2026-10-11T17:00:00Z',
  file: 'MEMORY.md',
  op: 'consolidate',
  actor: 'system',
  summary: 'Merged 2 daily logs into <MEMORY.md>.',
  why: { what: 'Memory consolidated', by: 'system', outcome: 'Merged 2 daily logs.' },
  ...over,
});

describe('memoryHistoryUrl', () => {
  it('encodes the bot id and asks for the default limit', () => {
    expect(memoryHistoryUrl('a b')).toBe(
      `/api/agents/a%20b/memory-history?limit=${MEMORY_HISTORY_LIMIT}`
    );
  });
});

describe('memoryHistoryRow', () => {
  it('shows the what, the op label, the escaped summary, when, and the shared fold', () => {
    const html = memoryHistoryRow(ev(), { nowMs: NOW, botId: 'b1' });
    expect(html).toContain('Memory consolidated');
    expect(html).toContain('Merged 2 daily logs into &lt;MEMORY.md&gt;.');
    expect(html).toContain('1h ago');
    expect(html).toContain('<details class="why">');
    expect(html).not.toContain('<MEMORY.md>');
  });

  it('tones a rejected consolidation as a warning', () => {
    const html = memoryHistoryRow(
      ev({ op: 'consolidate-rejected', why: { what: 'Memory consolidation rejected' } }),
      { nowMs: NOW }
    );
    expect(html).toContain('ui-badge-warn');
  });

  it('falls back to the op when the why is missing', () => {
    const html = memoryHistoryRow(ev({ op: 'facts-saved', why: undefined }), { nowMs: NOW });
    expect(html).toContain('facts saved');
    expect(html).not.toContain('<details');
  });
});

describe('memoryHistoryBody', () => {
  it('empty state when nothing was recorded', () => {
    expect(memoryHistoryBody({ events: [] })).toContain('No memory edits yet');
    expect(memoryHistoryBody(null)).toContain('No memory edits yet');
  });

  it('an error message when the request failed', () => {
    expect(memoryHistoryBody({ error: 'boom <x>' })).toContain('boom &lt;x&gt;');
  });

  it('one row per event and a count when the log holds more', () => {
    const html = memoryHistoryBody(
      { events: [ev(), ev({ op: 'facts-saved' })], total: 9 },
      { nowMs: NOW, botId: 'b1' }
    );
    expect(html.match(/class="home-mem-row"/g)).toHaveLength(2);
    expect(html).toContain('Showing the latest 2 of 9');
  });
});

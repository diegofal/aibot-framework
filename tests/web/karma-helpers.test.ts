import { describe, expect, it } from 'bun:test';
import {
  agentNames,
  filterKarma,
  karmaEventRow,
  karmaToolbar,
  sortKarma,
} from '../../web/pages/karma-helpers.js';

const scores = [
  { botId: 'b1', current: 40, trend: 'rising', recentEvents: [1, 2] },
  { botId: 'b2', current: 90, trend: 'stable', recentEvents: [] },
  { botId: 'gone', current: 10, trend: 'falling', recentEvents: [1] },
];
const names = { b1: 'Zeta', b2: 'Alpha' };

describe('agentNames', () => {
  it('maps id to name, falling back to the id', () => {
    expect(agentNames([{ id: 'a', name: 'A' }, { id: 'b' }])).toEqual({ a: 'A', b: 'b' });
    expect(agentNames({ error: 'x' })).toEqual({});
  });
});

describe('filterKarma', () => {
  it('matches agent name or id', () => {
    expect(filterKarma(scores, { query: 'alp', names }).map((s) => s.botId)).toEqual(['b2']);
    expect(filterKarma(scores, { query: 'GONE', names }).map((s) => s.botId)).toEqual(['gone']);
  });
  it('filters by trend', () => {
    expect(filterKarma(scores, { trend: 'falling', names }).map((s) => s.botId)).toEqual(['gone']);
  });
});

describe('sortKarma', () => {
  it('sorts by score both ways, by name and by events, without mutating', () => {
    const copy = [...scores];
    expect(sortKarma(scores, 'score-desc', names).map((s) => s.botId)).toEqual([
      'b2',
      'b1',
      'gone',
    ]);
    expect(sortKarma(scores, 'score-asc', names).map((s) => s.botId)).toEqual(['gone', 'b1', 'b2']);
    expect(sortKarma(scores, 'name', names).map((s) => s.botId)).toEqual(['b2', 'gone', 'b1']);
    expect(sortKarma(scores, 'events', names).map((s) => s.botId)).toEqual(['b1', 'gone', 'b2']);
    expect(scores).toEqual(copy);
  });
});

describe('karmaToolbar', () => {
  it('renders a page filter and keeps the selections', () => {
    const html = karmaToolbar({ query: 'x', sortBy: 'name', trend: 'rising' });
    expect(html).toContain('data-page-filter');
    expect(html).toContain('<option value="name" selected>');
    expect(html).toContain('<option value="rising" selected>');
  });
});

describe('karmaEventRow', () => {
  const NOW = Date.parse('2026-10-11T12:00:00Z');
  const evt = {
    id: 'k1',
    botId: 'b1',
    timestamp: '2026-10-11T11:00:00Z',
    delta: -1,
    reason: 'Tool error: <web_fetch>',
    source: 'tool',
    why: { what: 'A tool call failed', by: 'agent', cycle: { id: 'c-1', botId: 'b1' } },
  };

  it('renders delta, source, escaped reason, time and the shared Why fold', () => {
    const html = karmaEventRow(evt, { nowMs: NOW, botId: 'b1' });
    expect(html).toContain('-1');
    expect(html).toContain('badge-error');
    expect(html).toContain('Tool error: &lt;web_fetch&gt;');
    expect(html).toContain('1h ago');
    expect(html).toContain('<details class="why">');
    expect(html).toContain('data-open-cycle="c-1"');
  });

  it('an event without a why renders no fold', () => {
    const html = karmaEventRow({ ...evt, why: undefined, delta: 2 }, { nowMs: NOW });
    expect(html).toContain('+2');
    expect(html).not.toContain('<details');
  });
});

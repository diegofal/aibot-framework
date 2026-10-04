import { describe, expect, it } from 'bun:test';
import {
  FLEET_FILTER_KEY,
  filterFleet,
  fleetCard,
  fleetErrorState,
  fleetFilterChips,
  fleetFilterCounts,
  fleetGrid,
  fleetQuickActions,
  readFleetFilter,
  writeFleetFilter,
} from '../../web/pages/fleet-home-helpers.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const agents = [
  { id: 'a', name: 'Ada', running: true, enabled: true },
  { id: 'b', name: 'Bob', running: false, enabled: true },
  { id: 'c', name: 'Cy', running: false, enabled: false },
  { id: 'd', name: 'Dee', running: true, enabled: true },
];
const presence = {
  a: { running: true, enabled: true, posture: 'active', pendingAsks: 2 },
  b: { running: false, enabled: true, posture: 'idle', unreviewed: 1 },
  c: { running: false, enabled: false, posture: 'dormant' },
  d: { running: true, enabled: true, posture: 'blocked' },
};

function memStorage(init = {}) {
  const data = { ...init };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

describe('filterFleet', () => {
  it('keeps everyone for all', () => {
    expect(filterFleet(agents, presence, 'all').length).toBe(4);
  });
  it('filters running, blocked and needs you', () => {
    expect(filterFleet(agents, presence, 'running').map((x) => x.id)).toEqual(['a', 'd']);
    expect(filterFleet(agents, presence, 'blocked').map((x) => x.id)).toEqual(['d']);
    expect(filterFleet(agents, presence, 'needs').map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('falls back to the agent row when presence is missing', () => {
    expect(filterFleet(agents, {}, 'running').map((x) => x.id)).toEqual(['a', 'd']);
  });
  it('counts each chip', () => {
    expect(fleetFilterCounts(agents, presence)).toEqual({
      all: 4,
      running: 2,
      blocked: 1,
      needs: 2,
    });
  });
});

describe('fleet filter prefs', () => {
  it('defaults to all and round-trips valid values', () => {
    const s = memStorage();
    expect(readFleetFilter(s)).toBe('all');
    writeFleetFilter(s, 'blocked');
    expect(readFleetFilter(s)).toBe('blocked');
    expect(readFleetFilter(memStorage({ [FLEET_FILTER_KEY]: 'zzz' }))).toBe('all');
    expect(readFleetFilter(null)).toBe('all');
  });
});

describe('fleetFilterChips', () => {
  it('marks the active chip and shows counts', () => {
    const html = fleetFilterChips('needs', { all: 4, running: 2, blocked: 1, needs: 2 });
    expect(html).toMatch(/data-fleet-filter="needs"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-fleet-filter="all"[^>]*aria-pressed="false"/);
    expect(html).toContain('Needs you');
  });
});

describe('fleetQuickActions', () => {
  it('offers Run now and Stop for a running agent', () => {
    const html = fleetQuickActions(agents[0], presence.a);
    expect(html).toContain('data-quick="run"');
    expect(html).toContain('Run now');
    expect(html).toContain('data-quick="stop"');
    expect(html).not.toContain('data-quick="start"');
  });
  it('offers Start, or Enable & Start for a disabled agent', () => {
    expect(fleetQuickActions(agents[1], presence.b)).toContain('data-quick="start"');
    const off = fleetQuickActions(agents[2], presence.c);
    expect(off).toContain('data-quick="enable-start"');
    expect(off).toContain('Enable &amp; Start');
  });
});

describe('fleetCard', () => {
  it('carries quick actions and sends asks to the Needs You queue', () => {
    const html = fleetCard(agents[0], presence.a, NOW);
    expect(html).toContain('fleet-quick');
    expect(html).toContain('href="#/needs?bot=a"');
    expect(html).not.toContain('#/needs/inbox');
  });
});

describe('fleetGrid', () => {
  it('points the empty state at the wizard', () => {
    expect(fleetGrid([], {}, NOW)).toContain('href="#/agents/new"');
  });
  it('shows a no-match state with a reset when a filter hides everyone', () => {
    const html = fleetGrid([], {}, NOW, { filtered: true });
    expect(html).toContain('No agents match');
    expect(html).toContain('data-fleet-filter="all"');
  });
});

describe('fleetErrorState', () => {
  it('renders the message and a Retry button, escaped', () => {
    const html = fleetErrorState('<boom>');
    expect(html).toContain('&lt;boom&gt;');
    expect(html).toContain('data-action="fleet-retry"');
    expect(html).not.toContain('No agents yet');
  });
});

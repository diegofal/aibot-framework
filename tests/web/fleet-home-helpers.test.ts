import { describe, expect, it } from 'bun:test';
import {
  POSTURE_ORDER,
  TICKER_LIMIT,
  TICKER_SHOW,
  condenseEvents,
  condensedTickerBody,
  describeEvent,
  fleetCard,
  fleetGrid,
  fleetSummary,
  pushTicker,
  sortFleet,
  tickerBody,
  tickerRow,
} from '../../web/pages/fleet-home-helpers.js';

const NOW = 1_700_000_000_000;
const M = 60_000;
const H = 60 * M;

const agents = [
  { id: 'b1', name: 'Bot One', enabled: true, running: true },
  { id: 'b2', name: 'Bot Two', enabled: false, running: false },
  { id: 'b3', name: 'Bot Three', enabled: true, running: true },
  { id: 'b4', name: '<b>Evil</b>', enabled: true, running: true },
];

const presence = {
  b1: {
    id: 'b1',
    name: 'Bot One',
    posture: 'active',
    nowLine: "I'm working: running web_search.",
    tone: 'info',
    enabled: true,
    running: true,
    isExecuting: true,
    karma: 62,
    pendingAsks: 2,
    unreviewed: 1,
    lastOutputAt: new Date(NOW - 3 * H).toISOString(),
    nextRunAt: null,
    channel: { kind: 'telegram', state: 'ok' },
  },
  b2: {
    id: 'b2',
    name: 'Bot Two',
    posture: 'dormant',
    nowLine: "I'm disabled.",
    tone: 'muted',
    enabled: false,
    running: false,
    isExecuting: false,
    karma: null,
    pendingAsks: 0,
    unreviewed: 0,
    lastOutputAt: null,
    nextRunAt: null,
    channel: { kind: 'headless', state: 'placeholder' },
  },
  b3: {
    id: 'b3',
    name: 'Bot Three',
    posture: 'blocked',
    nowLine: "I'm blocked: 429 quota.",
    tone: 'danger',
    enabled: true,
    running: true,
    isExecuting: false,
    karma: 40,
    pendingAsks: 0,
    unreviewed: 0,
    lastOutputAt: new Date(NOW - 2 * 86_400_000).toISOString(),
    nextRunAt: new Date(NOW + 10 * M).toISOString(),
    channel: { kind: 'headless', state: 'missing' },
  },
};

const names = { b1: 'Bot One', b3: 'Bot Three' };

describe('sortFleet', () => {
  it('puts executing bots first, then by posture severity, then by name', () => {
    expect(sortFleet(agents, presence).map((a) => a.id)).toEqual(['b1', 'b3', 'b4', 'b2']);
    expect(POSTURE_ORDER.blocked).toBeLessThan(POSTURE_ORDER.active);
    expect(POSTURE_ORDER.dormant).toBeGreaterThan(POSTURE_ORDER.unknown);
  });
  it('is stable for agents without presence and never mutates its input', () => {
    const input = [...agents];
    sortFleet(input, {});
    expect(input).toEqual(agents);
    expect(sortFleet([], presence)).toEqual([]);
  });
});

describe('fleetSummary', () => {
  it('counts running, executing, blocked and needs-you across the fleet', () => {
    expect(fleetSummary(agents, presence)).toEqual({
      total: 4,
      running: 3,
      executing: 1,
      blocked: 1,
      needsYou: 3,
    });
    expect(fleetSummary([], {})).toEqual({
      total: 0,
      running: 0,
      executing: 0,
      blocked: 0,
      needsYou: 0,
    });
  });
});

describe('fleetCard', () => {
  it('shows the uploaded face when the presence entry carries one', () => {
    const faced = { ...presence.b1, avatarUrl: '/api/agents/b1/avatar?v=9' };
    const html = fleetCard(agents[0], faced, NOW, { avatarSrc: (u) => `${u}&token=T` });
    expect(html).toContain('<img src="/api/agents/b1/avatar?v=9&amp;token=T"');
    expect(html).toContain('ui-avatar-dot-ok');
    const plain = fleetCard(agents[0], faced, NOW);
    expect(plain).toContain('<img src="/api/agents/b1/avatar?v=9"');
    expect(fleetCard(agents[0], presence.b1, NOW, { avatarSrc: () => 'never' })).toContain('<svg');
    expect(fleetGrid([agents[0]], { b1: faced }, NOW, { avatarSrc: (u) => `${u}&t=1` })).toContain(
      'avatar?v=9&amp;t=1'
    );
  });
  it('renders avatar, posture badge, now-line, karma, last output and asks', () => {
    const html = fleetCard(agents[0], presence.b1, NOW);
    expect(html).toContain('class="fleet-card fleet-card-executing" data-bot-id="b1"');
    expect(html).toContain('href="#/agents/b1"');
    expect(html).toContain('ui-avatar');
    expect(html).toContain('ui-avatar-dot-ok');
    expect(html).toContain('>active<');
    expect(html).toContain('class="fleet-now fleet-now-info"');
    expect(html).toContain('I&#39;m working: running web_search.');
    expect(html).toContain('Karma 62');
    expect(html).toContain('Output 3h ago');
    expect(html).toContain('href="#/needs"');
    expect(html).toContain('2 asks');
    expect(html).toContain('1 to review');
    expect(html).toContain('href="#/work/productions/b1"');
    expect(html).toContain('telegram');
  });

  it('escapes names, shows stopped and disabled states, and has no asks link at zero', () => {
    const html = fleetCard(agents[3], undefined, NOW);
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('>unknown<');
    expect(html).toContain('Loading…');
    expect(html).not.toContain('asks');

    const off = fleetCard(agents[1], presence.b2, NOW);
    expect(off).toContain('fleet-card-off');
    expect(off).toContain('>disabled<');
    const stopped = fleetCard(
      { id: 'b9', name: 'Nine', enabled: true, running: false },
      undefined,
      NOW
    );
    expect(stopped).toContain('>stopped<');
    expect(stopped).toContain('fleet-card-off');
    expect(off).toContain('Karma —');
    expect(off).toContain('No output yet');
  });

  it('mentions the next run when known', () => {
    const html = fleetCard(agents[2], presence.b3, NOW);
    expect(html).toContain('next run in 10m');
    expect(html).toContain('fleet-now-danger');
  });
});

describe('fleetGrid', () => {
  it('renders one card per agent in fleet order', () => {
    const html = fleetGrid(agents, presence, NOW);
    const ids = [...html.matchAll(/data-bot-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['b1', 'b3', 'b4', 'b2']);
    expect(html).toContain('class="fleet-grid"');
  });
  it('renders an empty state with a link to create an agent', () => {
    const html = fleetGrid([], {}, NOW);
    expect(html).toContain('ui-empty');
    expect(html).toContain('No agents yet');
    expect(html).toContain('href="#/agents/new"');
  });
});

describe('describeEvent', () => {
  const ev = (type, data = {}, botId = 'b1') => ({ type, botId, timestamp: NOW, data });

  it('turns every activity event type into a short fleet sentence', () => {
    expect(describeEvent(ev('tool:start', { toolName: 'web_search' }), names)).toEqual({
      text: 'Bot One is running web_search',
      tone: 'info',
    });
    expect(describeEvent(ev('tool:end', { toolName: 'web_search', success: true }), names)).toEqual(
      { text: 'Bot One finished web_search', tone: 'ok' }
    );
    expect(
      describeEvent(ev('tool:end', { toolName: 'web_search', success: false }), names)
    ).toEqual({ text: 'Bot One: web_search failed', tone: 'danger' });
    expect(describeEvent(ev('tool:error', { toolName: 'x', error: 'boom' }), names)).toEqual({
      text: 'Bot One: x failed — boom',
      tone: 'danger',
    });
    expect(describeEvent(ev('llm:start', { caller: 'planner' }), names)).toEqual({
      text: 'Bot One is thinking (planner)',
      tone: 'info',
    });
    expect(describeEvent(ev('llm:end', { caller: 'planner' }), names)).toEqual({
      text: 'Bot One got an answer (planner)',
      tone: 'muted',
    });
    expect(describeEvent(ev('llm:error', { caller: 'executor', error: '429' }), names)).toEqual({
      text: 'Bot One: LLM call failed (executor) — 429',
      tone: 'danger',
    });
    expect(
      describeEvent(
        ev('llm:fallback', { primaryBackend: 'claude-cli', fallbackBackend: 'ollama' }),
        names
      )
    ).toEqual({ text: 'Bot One fell back from claude-cli to ollama', tone: 'warn' });
    expect(describeEvent({ ...ev('agent:phase'), phase: 'executor:start' }, names)).toEqual({
      text: 'Bot One: executor start',
      tone: 'info',
    });
    expect(describeEvent(ev('agent:idle'), names)).toEqual({
      text: 'Bot One is idle',
      tone: 'muted',
    });
    expect(describeEvent(ev('agent:result'), names)).toEqual({
      text: 'Bot One finished a cycle',
      tone: 'ok',
    });
    expect(describeEvent(ev('memory:flush'), names)).toEqual({
      text: 'Bot One saved memory',
      tone: 'muted',
    });
    expect(describeEvent(ev('memory:rag'), names)).toEqual({
      text: 'Bot One recalled memory',
      tone: 'muted',
    });
    expect(describeEvent(ev('collab:start', { targetBotId: 'b3' }), names)).toEqual({
      text: 'Bot One started collaborating with Bot Three',
      tone: 'accent',
    });
    expect(describeEvent(ev('collab:end'), names)).toEqual({
      text: 'Bot One finished collaborating',
      tone: 'accent',
    });
    expect(describeEvent(ev('compaction'), names)).toEqual({
      text: 'Bot One compacted its context',
      tone: 'muted',
    });
    expect(describeEvent(ev('karma:change', { delta: 3, reason: 'approved' }), names)).toEqual({
      text: 'Bot One karma +3 (approved)',
      tone: 'ok',
    });
    expect(describeEvent(ev('karma:change', { delta: -1 }), names)).toEqual({
      text: 'Bot One karma -1',
      tone: 'warn',
    });
    expect(describeEvent(ev('security:audit', {}, 'system'), names)).toEqual({
      text: 'Security audit ran',
      tone: 'muted',
    });
  });

  it('falls back to the bot id and the raw type for unknown input', () => {
    expect(describeEvent(ev('weird:thing', {}, 'zz'), names)).toEqual({
      text: 'zz: weird:thing',
      tone: 'muted',
    });
    expect(describeEvent(null, names)).toEqual({ text: '', tone: 'muted' });
    expect(describeEvent(ev('tool:start'), names)).toEqual({
      text: 'Bot One is running a tool',
      tone: 'info',
    });
  });
});

describe('ticker', () => {
  const ev = (type, ts, botId = 'b1', data = {}) => ({ type, botId, timestamp: ts, data });

  it('pushTicker keeps newest first, drops duplicates and caps at the limit', () => {
    let list = [];
    for (let i = 0; i < TICKER_LIMIT + 5; i++) {
      list = pushTicker(list, ev('agent:idle', NOW + i * 1000));
    }
    expect(list.length).toBe(TICKER_LIMIT);
    expect(list[0].timestamp).toBe(NOW + (TICKER_LIMIT + 4) * 1000);
    const again = pushTicker(list, list[0]);
    expect(again.length).toBe(TICKER_LIMIT);
    expect(again).toEqual(list);
    expect(pushTicker(list, null)).toBe(list);
  });

  it('tickerRow escapes and links the bot, tickerBody lists rows or an empty note', () => {
    const row = tickerRow(ev('tool:start', NOW - 2 * M, 'b1', { toolName: '<x>' }), names, NOW);
    expect(row).toContain('class="fleet-tick fleet-tick-info"');
    expect(row).toContain('href="#/agents/b1"');
    expect(row).toContain('is running &lt;x&gt;');
    expect(row).toContain('2m ago');
    expect(row).toContain(`data-ts="${NOW - 2 * M}"`);

    const body = tickerBody(
      [ev('agent:result', NOW - M), ev('agent:idle', NOW - 3 * M, 'b3')],
      names,
      NOW
    );
    expect(body.match(/class="fleet-tick /g)?.length).toBe(2);
    expect(body.indexOf('finished a cycle')).toBeLessThan(body.indexOf('is idle'));
    expect(tickerBody([], names, NOW)).toContain('Nothing has happened yet');
  });
});

describe('condensed ticker (S3.5)', () => {
  const ev = (type, ts, botId = 'b1', data = {}) => ({ type, botId, timestamp: ts, data });
  const cycle = [
    ev('agent:phase', NOW - 10 * M, 'b1', { phase: 'executing' }),
    ev('llm:start', NOW - 9 * M, 'b1', { caller: 'executor' }),
    ev('llm:end', NOW - 8 * M, 'b1', { caller: 'executor' }),
    ev('tool:start', NOW - 7 * M, 'b1', { toolName: 'file_read' }),
    ev('tool:end', NOW - 6 * M, 'b1', { toolName: 'file_read', success: true }),
    ev('tool:start', NOW - 5 * M, 'b1', { toolName: 'read_production_log' }),
    ev('tool:end', NOW - 4 * M, 'b1', { toolName: 'read_production_log', success: true }),
    ev('tool:start', NOW - 3 * M, 'b1', { toolName: 'manage_goals' }),
    ev('tool:end', NOW - 2 * M, 'b1', { toolName: 'manage_goals', success: true }),
    ev('agent:result', NOW - M, 'b1'),
  ];
  // Newest first, as pushTicker keeps it.
  const newestFirst = [...cycle].reverse();

  it('merges a cycle of tool start/end pairs into one line and drops LLM chatter', () => {
    const items = condenseEvents(newestFirst, names);
    expect(items.map((i) => i.text)).toEqual([
      'Bot One finished a cycle',
      'Bot One ran file_read, read_production_log and manage_goals',
    ]);
    expect(items[1].tone).toBe('ok');
    expect(items[1].timestamp).toBe(NOW - 2 * M);
    expect(items[1].botId).toBe('b1');
  });

  it('says "and N more tools" past three, keeps failures separate and a live tool as running', () => {
    const events = [
      ev('tool:end', NOW - 9 * M, 'b1', { toolName: 'a', success: true }),
      ev('tool:end', NOW - 8 * M, 'b1', { toolName: 'b', success: true }),
      ev('tool:end', NOW - 7 * M, 'b1', { toolName: 'c', success: true }),
      ev('tool:end', NOW - 6 * M, 'b1', { toolName: 'd', success: true }),
      ev('tool:end', NOW - 5 * M, 'b1', { toolName: 'e', success: true }),
      ev('tool:error', NOW - 4 * M, 'b1', { toolName: 'web_fetch', error: 'blocked' }),
      ev('tool:start', NOW - 3 * M, 'b1', { toolName: 'web_search' }),
    ].reverse();
    const items = condenseEvents(events, names);
    expect(items.map((i) => i.text)).toEqual([
      'Bot One is running web_search',
      'Bot One: web_fetch failed — blocked',
      'Bot One ran a, b and 3 more tools',
    ]);
    expect(items[0].tone).toBe('info');
    expect(items[1].tone).toBe('danger');
  });

  it('keeps separate agents apart and orders newest first', () => {
    const events = [
      ev('tool:end', NOW - 5 * M, 'b1', { toolName: 'x', success: true }),
      ev('tool:end', NOW - 4 * M, 'b3', { toolName: 'y', success: true }),
      ev('karma:change', NOW - 3 * M, 'b3', { delta: 2, reason: 'humanReply' }),
    ].reverse();
    const items = condenseEvents(events, names);
    expect(items.map((i) => i.text)).toEqual([
      'Bot Three karma +2 (humanReply)',
      'Bot Three ran y',
      'Bot One ran x',
    ]);
  });

  it('starts a new group after a long gap and tolerates junk', () => {
    const events = [
      ev('tool:end', NOW - 60 * M, 'b1', { toolName: 'x', success: true }),
      ev('tool:end', NOW - M, 'b1', { toolName: 'y', success: true }),
    ].reverse();
    expect(condenseEvents(events, names).map((i) => i.text)).toEqual([
      'Bot One ran y',
      'Bot One ran x',
    ]);
    expect(condenseEvents([null, { type: 5 }, {}], names)).toEqual([]);
    expect(condenseEvents([], names)).toEqual([]);
  });

  it('condensedTickerBody shows TICKER_SHOW items with a "more" toggle, or everything when expanded', () => {
    const many = [];
    for (let i = 0; i < TICKER_SHOW + 3; i++) {
      many.push(ev('agent:result', NOW - (i + 1) * M, i % 2 ? 'b1' : 'b3'));
    }
    const collapsed = condensedTickerBody(many, names, NOW);
    expect(collapsed.match(/class="fleet-tick /g)?.length).toBe(TICKER_SHOW);
    expect(collapsed).toContain('data-action="ticker-more"');
    expect(collapsed).toContain('3 more');
    const expanded = condensedTickerBody(many, names, NOW, { expanded: true });
    expect(expanded.match(/class="fleet-tick /g)?.length).toBe(TICKER_SHOW + 3);
    expect(expanded).toContain('data-action="ticker-less"');
    expect(condensedTickerBody(many.slice(0, 2), names, NOW)).not.toContain('ticker-more');
    expect(condensedTickerBody([], names, NOW)).toContain('Nothing has happened yet');
    expect(
      condensedTickerBody(
        [ev('tool:end', NOW - M, 'b4', { toolName: '<x>', success: true })],
        names,
        NOW
      )
    ).toContain('&lt;x&gt;');
  });

  it('fleetSummary prefers the server-side needs-you count when given', () => {
    expect(fleetSummary(agents, presence, { needsYou: 39 }).needsYou).toBe(39);
    expect(fleetSummary(agents, presence, { needsYou: null }).needsYou).toBe(
      fleetSummary(agents, presence).needsYou
    );
  });
});

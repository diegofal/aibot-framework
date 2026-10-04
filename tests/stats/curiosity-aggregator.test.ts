import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleTopicEntry, Dispatch } from '../../src/bot/curiosity/types';
import { createStatsContext } from '../../src/stats/context';
import {
  buildCuriosityStats,
  classifyDispatchLanding,
  dailyMix,
  dispatchLanding,
  diversityTimeline,
} from '../../src/stats/curiosity-aggregator';
import { readCuriosityState } from '../../src/stats/readers/curiosity';
import { removeTempDir } from '../helpers/temp-dir';
import { DAY, H, type StatsFixture, createStatsFixture } from './fixture';

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-10-10T12:00:00.000Z');

function cycle(
  atMs: number,
  topic: string,
  mode: 'explore' | 'exploit' = 'exploit',
  surprised = false
): CycleTopicEntry {
  return { at: iso(atMs), topic, mode, surprised };
}

function dispatch(over: Partial<Dispatch>): Dispatch {
  return {
    id: over.id ?? 'd',
    botId: 'b1',
    createdAt: iso(NOW - H),
    kind: 'insight',
    topic: 't',
    hook: 'h',
    whyCare: 'w',
    evidence: 'e',
    action: 'a',
    body: 'body',
    editorScore: 0.8,
    status: 'sent',
    ...over,
  };
}

describe('classifyDispatchLanding', () => {
  it('a signal wins regardless of age', () => {
    expect(classifyDispatchLanding(dispatch({ signal: 'up' }), NOW)).toBe('up');
    expect(classifyDispatchLanding(dispatch({ signal: 'more' }), NOW)).toBe('more');
    expect(classifyDispatchLanding(dispatch({ signal: 'down' }), NOW)).toBe('down');
  });

  it('a Telegram dispatch with no signal after 48 h is ignored, before that pending', () => {
    const old = dispatch({ sentAt: iso(NOW - 49 * H), deliveredVia: 'telegram' });
    const fresh = dispatch({ sentAt: iso(NOW - 47 * H), deliveredVia: 'telegram' });
    expect(classifyDispatchLanding(old, NOW)).toBe('ignored');
    expect(classifyDispatchLanding(fresh, NOW)).toBe('pending');
  });

  it('falls back to createdAt when sentAt is missing', () => {
    expect(classifyDispatchLanding(dispatch({ createdAt: iso(NOW - 3 * DAY) }), NOW)).toBe(
      'ignored'
    );
  });

  it('an inbox-only dispatch never counts as ignored (same rule as the taste model)', () => {
    const d = dispatch({ sentAt: iso(NOW - 10 * DAY), deliveredVia: 'inbox' });
    expect(classifyDispatchLanding(d, NOW)).toBe('pending');
  });

  it('held and dropped dispatches have no landing', () => {
    expect(classifyDispatchLanding(dispatch({ status: 'held' }), NOW)).toBeNull();
    expect(classifyDispatchLanding(dispatch({ status: 'dropped', signal: 'up' }), NOW)).toBeNull();
  });
});

describe('dispatchLanding', () => {
  it('counts outcomes and computes the landing rate over resolved dispatches only', () => {
    const s = dispatchLanding(
      [
        dispatch({ id: '1', signal: 'up', editorScore: 0.9 }),
        dispatch({ id: '2', signal: 'more', editorScore: 0.8 }),
        dispatch({ id: '3', signal: 'down', editorScore: 0.75 }),
        dispatch({
          id: '4',
          sentAt: iso(NOW - 3 * DAY),
          deliveredVia: 'telegram',
          editorScore: 0.7,
        }),
        dispatch({ id: '5', sentAt: iso(NOW - H), editorScore: 0.72 }),
        dispatch({ id: '6', status: 'held', editorScore: 0.5 }),
        dispatch({ id: '7', status: 'dropped', editorScore: 0.3 }),
      ],
      NOW
    );
    expect(s).toEqual({
      sent: 5,
      up: 1,
      more: 1,
      down: 1,
      ignored: 1,
      pending: 1,
      landingRate: 0.5,
      held: 1,
      dropped: 1,
      medianEditorScore: 0.72,
    });
  });

  it('landing rate is null when nothing has resolved yet', () => {
    const s = dispatchLanding([dispatch({ sentAt: iso(NOW - H) })], NOW);
    expect(s.pending).toBe(1);
    expect(s.landingRate).toBeNull();
  });

  it('empty input gives zeros and null medians', () => {
    const s = dispatchLanding([], NOW);
    expect(s.sent).toBe(0);
    expect(s.medianEditorScore).toBeNull();
    expect(s.landingRate).toBeNull();
  });
});

describe('diversityTimeline', () => {
  it('reports distinct topics and dominant share over the trailing window', () => {
    const log = [
      cycle(NOW - 4 * H, 'a'),
      cycle(NOW - 3 * H, 'a'),
      cycle(NOW - 2 * H, 'b', 'explore', true),
      cycle(NOW - H, 'c'),
    ];
    const points = diversityTimeline(log, 3, 0);
    expect(points.map((p) => [p.topic, p.distinctTopics, p.dominantShare])).toEqual([
      ['a', 1, 1],
      ['a', 1, 1],
      ['b', 2, 0.67],
      ['c', 3, 0.33],
    ]);
    expect(points[2]).toMatchObject({ mode: 'explore', surprised: true });
  });

  it('only returns points inside the window, but pre-window cycles still feed the trailing stats', () => {
    const log = [cycle(NOW - 3 * DAY, 'a'), cycle(NOW - 2 * DAY, 'a'), cycle(NOW - H, 'b')];
    const points = diversityTimeline(log, 8, NOW - DAY);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ topic: 'b', distinctTopics: 2, dominantShare: 0.67 });
  });

  it('skips entries with an unparseable timestamp', () => {
    const points = diversityTimeline(
      [{ at: 'nope', topic: 'a', mode: 'exploit', surprised: false }],
      8,
      0
    );
    expect(points).toEqual([]);
  });
});

describe('dailyMix', () => {
  it('buckets cycles by UTC day with the explore/exploit split and distinct topics', () => {
    const d1 = Date.parse('2026-10-08T03:00:00.000Z');
    const d2 = Date.parse('2026-10-09T03:00:00.000Z');
    const mix = dailyMix([
      cycle(d1, 'a'),
      cycle(d1 + H, 'b', 'explore', true),
      cycle(d1 + 2 * H, 'a'),
      cycle(d2, 'a'),
    ]);
    expect(mix).toEqual([
      { date: '2026-10-08', cycles: 3, explore: 1, exploit: 2, surprised: 1, distinctTopics: 2 },
      { date: '2026-10-09', cycles: 1, explore: 0, exploit: 1, surprised: 0, distinctTopics: 1 },
    ]);
  });
});

// ── On-disk aggregation ──

let fx: StatsFixture;
beforeEach(() => {
  fx = createStatsFixture();
});
afterEach(() => removeTempDir(fx.dir));

function writeSoul(botId: string, files: Record<string, unknown>, dispatches: Dispatch[] = []) {
  const soul = fx.soulDir(botId);
  mkdirSync(soul, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(soul, name), JSON.stringify(value));
  }
  if (dispatches.length > 0) {
    writeFileSync(
      join(soul, 'DISPATCHES.jsonl'),
      `${dispatches.map((d) => JSON.stringify(d)).join('\n')}\n`
    );
  }
}

function seedB1() {
  const now = fx.now;
  writeSoul(
    'b1',
    {
      'KNOWLEDGE.json': {
        version: 1,
        topics: [
          {
            id: 'rag',
            name: 'RAG evals',
            depth: 2,
            firstSeen: iso(now - 9 * DAY),
            lastTouched: iso(now - H),
            cycles: 5,
            findings: [{ id: 'f', claim: 'c', confidence: 'high', at: iso(now) }],
            surprises: [{ id: 's', text: 'x', at: iso(now) }],
            openQuestions: ['q1', 'q2'],
            outputs: [],
          },
          {
            id: 'mcp',
            name: 'MCP',
            depth: 1,
            firstSeen: iso(now - DAY),
            lastTouched: iso(now - H),
            cycles: 1,
            findings: [],
            surprises: [],
            openQuestions: [],
            outputs: [],
          },
        ],
        frontier: [
          { id: 'f1', status: 'open' },
          { id: 'f2', status: 'open' },
          { id: 'f3', status: 'explored' },
        ],
        interests: ['jazz'],
        updatedAt: iso(now - H),
      },
      'NAVIGATOR.json': {
        version: 1,
        lastNavigatorAt: iso(now - 2 * H),
        direction: {
          at: iso(now - 2 * H),
          summary: 'Go wide',
          retrospective: 'r',
          bets: [
            { id: 'x', title: 'Ship', kind: 'exploit', rationale: 'r' },
            { id: 'y', title: 'Roam', kind: 'explore', rationale: 'r' },
          ],
        },
        directives: [],
        cycleLog: [
          cycle(now - 10 * DAY, 'rag'),
          cycle(now - 3 * DAY, 'rag'),
          cycle(now - 2 * DAY, 'mcp', 'explore', true),
          cycle(now - H, 'rag'),
        ],
        cyclesSinceExplore: 1,
        noSurpriseStreak: 1,
      },
      'TASTE.json': {
        version: 1,
        topics: {},
        kinds: {},
        likedHooks: [],
        dislikedHooks: [],
        cadence: { intervalHours: 9, lastSentAt: null },
        updatedAt: null,
      },
    },
    [
      dispatch({ id: 'old', createdAt: iso(now - 20 * DAY), signal: 'up' }),
      dispatch({ id: 'a', createdAt: iso(now - 2 * DAY), signal: 'up', editorScore: 0.9 }),
      dispatch({ id: 'b', createdAt: iso(now - H), status: 'held', editorScore: 0.5 }),
    ]
  );
}

describe('readCuriosityState', () => {
  it('returns nulls and an empty dispatch list for a soul without curiosity files', () => {
    expect(readCuriosityState(fx.soulDir('b2'))).toEqual({
      knowledge: null,
      navigator: null,
      taste: null,
      dispatches: [],
    });
  });

  it('skips malformed dispatch lines', () => {
    const soul = fx.soulDir('b2');
    mkdirSync(soul, { recursive: true });
    writeFileSync(
      join(soul, 'DISPATCHES.jsonl'),
      `${JSON.stringify(dispatch({ id: 'ok' }))}\n{broken\n`
    );
    expect(readCuriosityState(soul).dispatches.map((d) => d.id)).toEqual(['ok']);
  });
});

describe('buildCuriosityStats', () => {
  it('aggregates knowledge, cycle mix, diversity and dispatch landing inside the window', () => {
    seedB1();
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const res = buildCuriosityStats(ctx, [fx.bots.b1], '7d');
    expect(res.window).toBe('7d');
    expect(res.cycleLogCap).toBe(30);
    expect(res.ignoredAfterHours).toBe(48);

    const b = res.bots[0];
    expect(b.botId).toBe('b1');
    expect(b.curiosityEnabled).toBe(true);
    expect(b.topicWindow).toBe(8);
    expect(b.knowledge).toEqual({
      topics: 2,
      findings: 1,
      surprises: 1,
      openQuestions: 2,
      interests: 1,
      frontier: { open: 2, explored: 1 },
      topTopics: [
        { name: 'RAG evals', depth: 2, cycles: 5 },
        { name: 'MCP', depth: 1, cycles: 1 },
      ],
      updatedAt: iso(fx.now - H),
    });
    // The 10-day-old cycle is outside 7d.
    expect(b.cycles).toEqual({
      total: 3,
      explore: 1,
      exploit: 2,
      surprised: 1,
      exploreShare: 0.33,
      distinctTopics: 2,
      dominantTopic: 'rag',
      dominantShare: 0.67,
      historyStart: iso(fx.now - 10 * DAY),
    });
    expect(b.diversity).toHaveLength(3);
    // The pre-window cycle still counts in the trailing window of the first point.
    expect(b.diversity[0]).toMatchObject({ topic: 'rag', distinctTopics: 1, dominantShare: 1 });
    expect(b.daily.reduce((n, d) => n + d.cycles, 0)).toBe(3);
    expect(b.direction).toEqual({
      at: iso(fx.now - 2 * H),
      summary: 'Go wide',
      bets: [
        { title: 'Ship', kind: 'exploit' },
        { title: 'Roam', kind: 'explore' },
      ],
    });
    expect(b.lastNavigatorAt).toBe(iso(fx.now - 2 * H));
    expect(b.cadenceHours).toBe(9);
    // 'old' (20 days) is outside the window.
    expect(b.dispatches).toMatchObject({ sent: 1, up: 1, held: 1, landingRate: 1 });

    expect(res.fleet).toMatchObject({ cycles: 3, explore: 1, exploit: 2 });
    expect(res.fleet.dispatches).toMatchObject({ sent: 1, up: 1, held: 1, landingRate: 1 });
  });

  it('a bot with no curiosity state yields an empty, zeroed entry', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const b = buildCuriosityStats(ctx, [fx.bots.b2], '7d').bots[0];
    expect(b.knowledge.topics).toBe(0);
    expect(b.knowledge.updatedAt).toBeNull();
    expect(b.cycles).toMatchObject({
      total: 0,
      exploreShare: null,
      dominantTopic: null,
      historyStart: null,
    });
    expect(b.diversity).toEqual([]);
    expect(b.direction).toBeNull();
    expect(b.cadenceHours).toBeNull();
    expect(b.dispatches.sent).toBe(0);
  });

  it('reports curiosity disabled per bot and honours a per-bot topicWindow', () => {
    const off = { ...fx.bots.b1, agentLoop: { curiosity: { enabled: false } } } as never;
    const narrow = { ...fx.bots.b3, agentLoop: { curiosity: { topicWindow: 4 } } } as never;
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const [a, b] = buildCuriosityStats(ctx, [off, narrow], '7d').bots;
    expect(a.curiosityEnabled).toBe(false);
    expect(b.curiosityEnabled).toBe(true);
    expect(b.topicWindow).toBe(4);
  });
});

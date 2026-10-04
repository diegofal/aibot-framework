import { describe, expect, it } from 'bun:test';
import {
  CURIOSITY_DEFAULTS,
  CURIOSITY_PRESETS as TS_PRESETS,
} from '../../src/bot/curiosity/config';
import { DIAL_MEANINGS as TS_MEANINGS } from '../../src/bot/curiosity/dna';
import { LIMIT_DIALS as TS_DIALS } from '../../src/bot/curiosity/types';
import {
  CURIOSITY_PRESETS,
  CURIOSITY_UI_DEFAULTS,
  DIAL_MEANINGS,
  LIMIT_DIALS,
  curiosityFormSection,
  curiositySummary,
  depthBar,
  directionPanel,
  dispatchCard,
  dispatchCounts,
  dispatchList,
  dnaLine,
  exploreMix,
  filterDispatches,
  frontierPanel,
  knowledgePanel,
  mindSection,
  previewDials,
  readCuriosityForm,
  signalButtons,
  signalRequest,
} from '../../web/pages/curiosity-helpers.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function dispatch(over: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    botId: 'b1',
    botName: 'Scout',
    createdAt: hoursAgo(2),
    kind: 'insight',
    topic: 'retrieval',
    hook: 'Reranking beats bigger embeddings <here>',
    whyCare: 'Your search bill halves',
    evidence: 'bench: 3 datasets',
    action: 'Try a cross-encoder',
    body: 'b',
    editorScore: 0.82,
    status: 'sent',
    ...over,
  };
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    botId: 'b1',
    config: {
      enabled: true,
      preset: 'explorer',
      limits: { ...TS_PRESETS.explorer },
      exploreRatio: 0.25,
      maxTopicShare: 0.6,
      topicWindow: 8,
      dispatch: { enabled: true, maxChars: 1200 },
    },
    map: {
      version: 1,
      topics: [
        {
          id: 'rag',
          name: 'RAG',
          depth: 2,
          firstSeen: hoursAgo(100),
          lastTouched: hoursAgo(1),
          cycles: 4,
          findings: [
            { id: 'f1', claim: 'Chunk size matters less', confidence: 'high', at: hoursAgo(1) },
          ],
          surprises: [{ id: 's1', text: 'BM25 won', at: hoursAgo(3) }],
          openQuestions: ['Does reranking scale?'],
          outputs: [],
        },
        {
          id: 'old',
          name: 'Old topic',
          depth: 0,
          firstSeen: hoursAgo(300),
          lastTouched: hoursAgo(200),
          cycles: 1,
          findings: [],
          surprises: [],
          openQuestions: [],
          outputs: [],
        },
      ],
      frontier: [],
      interests: [],
      updatedAt: hoursAgo(1),
    },
    navigator: {
      version: 1,
      lastNavigatorAt: hoursAgo(5),
      direction: {
        at: hoursAgo(5),
        summary: 'Go deeper on reranking',
        retrospective: 'Last week was all chunking',
        bets: [
          { id: 'x1', title: 'Rerankers', kind: 'exploit', rationale: 'core' },
          { id: 'x2', title: 'Music theory', kind: 'explore', rationale: 'far' },
        ],
      },
      directives: [],
      cycleLog: [
        { at: hoursAgo(9), topic: 'rag', mode: 'exploit', surprised: false },
        { at: hoursAgo(8), topic: 'rag', mode: 'exploit', surprised: true },
        { at: hoursAgo(7), topic: 'music', mode: 'explore', surprised: true },
        { at: hoursAgo(6), topic: 'rag', mode: 'exploit', surprised: false },
      ],
      cyclesSinceExplore: 1,
      noSurpriseStreak: 0,
    },
    taste: {},
    dispatches: [dispatch()],
    concentration: { dominantTopic: 'rag', share: 0.75, count: 3, window: 4 },
    frontier: [
      {
        item: {
          id: 'fr1',
          question: 'Do bees do RAG?',
          whyInteresting: 'Swarm retrieval',
          distance: 2,
          surpriseScore: 0.9,
          createdAt: hoursAgo(4),
          status: 'open',
        },
        verdict: {
          allowed: false,
          crosses: ['topic', 'purpose'],
          needsApproval: ['purpose'],
          blockedBy: [],
        },
      },
      {
        item: {
          id: 'fr2',
          question: 'Hybrid search costs',
          whyInteresting: 'cheap',
          bridge: 'serves search',
          distance: 1,
          surpriseScore: 0.4,
          createdAt: hoursAgo(4),
          status: 'open',
        },
        verdict: { allowed: true, crosses: [], needsApproval: [], blockedBy: [] },
      },
      {
        item: {
          id: 'fr3',
          question: 'Dropped one',
          whyInteresting: '',
          distance: 3,
          surpriseScore: 0.95,
          createdAt: hoursAgo(4),
          status: 'dropped',
        },
        verdict: { allowed: false, crosses: ['topic'], needsApproval: [], blockedBy: ['topic'] },
      },
    ],
    ...over,
  };
}

describe('parity with the server-side curiosity package', () => {
  it('mirrors the dials, presets and dial meanings', () => {
    expect(LIMIT_DIALS).toEqual([...TS_DIALS]);
    expect(CURIOSITY_PRESETS).toEqual(TS_PRESETS);
    expect(DIAL_MEANINGS).toEqual(TS_MEANINGS);
    expect(CURIOSITY_UI_DEFAULTS.preset).toBe(CURIOSITY_DEFAULTS.preset);
    expect(CURIOSITY_UI_DEFAULTS.exploreRatio).toBe(CURIOSITY_DEFAULTS.exploreRatio);
    expect(CURIOSITY_UI_DEFAULTS.dispatchMaxChars).toBe(CURIOSITY_DEFAULTS.dispatch.maxChars);
  });
});

describe('exploreMix', () => {
  it('counts explore vs exploit cycles', () => {
    expect(exploreMix(snapshot().navigator.cycleLog)).toEqual({
      explore: 1,
      exploit: 3,
      total: 4,
      exploreShare: 0.25,
    });
  });
  it('is all zero for an empty or missing log', () => {
    expect(exploreMix(undefined)).toEqual({ explore: 0, exploit: 0, total: 0, exploreShare: 0 });
  });
});

describe('dnaLine', () => {
  it('shows preset, six dials, explore target, mix and concentration', () => {
    const html = dnaLine(snapshot());
    expect(html).toContain('explorer');
    for (const d of LIMIT_DIALS) expect(html).toContain(d);
    expect(html).toContain('explore 25%');
    expect(html).toContain('1 explore / 3 exploit');
    expect(html).toContain('rag');
    expect(html).toContain('75%');
    // Over maxTopicShare → flagged as a rut.
    expect(html).toContain('curio-rut');
  });
  it('says curiosity is off when disabled', () => {
    const s = snapshot();
    s.config.enabled = false;
    expect(dnaLine(s)).toContain('Curiosity off');
  });
  it('does not flag a rut under the share cap', () => {
    const s = snapshot({
      concentration: { dominantTopic: 'rag', share: 0.4, count: 2, window: 5 },
    });
    expect(dnaLine(s)).not.toContain('curio-rut');
  });
});

describe('directionPanel', () => {
  it('renders summary, bets with mode badges, retrospective and signal buttons', () => {
    const html = directionPanel(snapshot().navigator.direction, 'b1', NOW);
    expect(html).toContain('Go deeper on reranking');
    expect(html).toContain('Rerankers');
    expect(html).toContain('>explore<');
    expect(html).toContain('>exploit<');
    expect(html).toContain('<details');
    expect(html).toContain('Last week was all chunking');
    expect(html).toContain('data-curio-kind="direction"');
  });
  it('marks the current operator verdict', () => {
    const d = { ...snapshot().navigator.direction, operatorSignal: 'up' };
    expect(directionPanel(d, 'b1', NOW)).toMatch(/data-signal="up"[^>]*aria-pressed="true"/);
  });
  it('shows an empty state without a direction', () => {
    expect(directionPanel(null, 'b1', NOW)).toContain('No direction yet');
  });
});

describe('knowledgePanel / depthBar', () => {
  it('depthBar fills depth of 3 segments and clamps', () => {
    expect((depthBar(2).match(/curio-depth-on/g) ?? []).length).toBe(2);
    expect((depthBar(9).match(/curio-depth-on/g) ?? []).length).toBe(3);
    expect((depthBar(-1).match(/curio-depth-on/g) ?? []).length).toBe(0);
  });
  it('lists topics newest first with findings, surprises and open questions', () => {
    const html = knowledgePanel(snapshot().map, NOW);
    expect(html.indexOf('RAG')).toBeLessThan(html.indexOf('Old topic'));
    expect(html).toContain('Chunk size matters less');
    expect(html).toContain('BM25 won');
    expect(html).toContain('Does reranking scale?');
  });
  it('empty map shows an empty state', () => {
    expect(knowledgePanel({ topics: [] }, NOW)).toContain('Nothing learned yet');
  });
});

describe('frontierPanel', () => {
  it('sorts by surprise, hides dropped items and shows verdict badges', () => {
    const html = frontierPanel(snapshot().frontier, 'b1');
    expect(html.indexOf('Do bees do RAG?')).toBeLessThan(html.indexOf('Hybrid search costs'));
    expect(html).not.toContain('Dropped one');
    expect(html).toContain('needs approval');
    expect(html).toContain('far');
    expect(html).toContain('0.90');
    expect(html).toContain('data-curio-kind="frontier"');
    expect(html).toContain('data-id="fr1"');
  });
  it('shows blocked items with the dial that blocks them', () => {
    const f = snapshot().frontier[2];
    f.item.status = 'open';
    expect(frontierPanel([f], 'b1')).toContain('blocked: topic');
  });
  it('empty frontier shows an empty state', () => {
    expect(frontierPanel([], 'b1')).toContain('No open questions');
  });
});

describe('dispatchCard / dispatchList', () => {
  it('leads with the escaped hook and folds the evidence', () => {
    const html = dispatchCard(dispatch(), { nowMs: NOW });
    expect(html).toContain('Reranking beats bigger embeddings &lt;here&gt;');
    expect(html).toMatch(/<details[^>]*>\s*<summary>Evidence<\/summary>/);
    expect(html).toContain('Try a cross-encoder');
    expect(html).toContain('data-signal="more"');
    expect(html).toContain('2h ago');
  });
  it('shows the bot when asked, with an avatar', () => {
    const html = dispatchCard(dispatch({ avatarUrl: '/a.png' }), {
      showBot: true,
      avatarSrc: (u: string) => `${u}?t=1`,
      nowMs: NOW,
    });
    expect(html).toContain('Scout');
    expect(html).toContain('/a.png?t=1');
    expect(html).toContain('href="#/agents/b1"');
  });
  it('marks held dispatches and proposals with crossings', () => {
    const html = dispatchCard(
      dispatch({ status: 'held', kind: 'proposal', crossing: ['purpose'] }),
      {
        nowMs: NOW,
      }
    );
    expect(html).toContain('held');
    expect(html).toContain('proposal');
    expect(html).toContain('crosses purpose');
  });
  it('marks the current signal', () => {
    expect(dispatchCard(dispatch({ signal: 'more' }), { nowMs: NOW })).toMatch(
      /data-signal="more"[^>]*aria-pressed="true"/
    );
  });
  it('dispatchList shows an empty state', () => {
    expect(dispatchList([], {})).toContain('No dispatches');
  });
});

describe('filterDispatches / dispatchCounts', () => {
  const list = [
    dispatch({ id: 'a', status: 'sent' }),
    dispatch({ id: 'b', status: 'held' }),
    dispatch({ id: 'c', status: 'held', kind: 'proposal' }),
    dispatch({ id: 'd', status: 'dropped' }),
  ];
  it('filters by status and kind', () => {
    expect(filterDispatches(list, 'all').map((d: { id: string }) => d.id)).toEqual(['a', 'b', 'c']);
    expect(filterDispatches(list, 'sent').map((d: { id: string }) => d.id)).toEqual(['a']);
    expect(filterDispatches(list, 'held').map((d: { id: string }) => d.id)).toEqual(['b', 'c']);
    expect(filterDispatches(list, 'proposals').map((d: { id: string }) => d.id)).toEqual(['c']);
    expect(filterDispatches(undefined, 'all')).toEqual([]);
  });
  it('counts per filter', () => {
    expect(dispatchCounts(list)).toEqual({ all: 3, sent: 1, held: 2, proposals: 1 });
  });
});

describe('signalButtons / signalRequest', () => {
  it('builds the request path per kind', () => {
    expect(signalRequest('dispatch', 'b 1', 'd/1', 'more')).toEqual({
      path: '/api/curiosity/b%201/dispatches/d%2F1/signal',
      body: { signal: 'more' },
    });
    expect(signalRequest('frontier', 'b1', 'f1', 'up').path).toBe(
      '/api/curiosity/b1/frontier/f1/signal'
    );
    expect(signalRequest('direction', 'b1', '', 'down').path).toBe(
      '/api/curiosity/b1/direction/signal'
    );
    expect(signalRequest('nope', 'b1', 'x', 'up')).toBeNull();
  });
  it('renders one button per signal with escaped data attributes', () => {
    const html = signalButtons('frontier', 'b"1', 'f1', 'down', ['up', 'down']);
    expect((html.match(/<button/g) ?? []).length).toBe(2);
    expect(html).toContain('data-bot="b&quot;1"');
    expect(html).toMatch(/data-signal="down"[^>]*aria-pressed="true"/);
  });
});

describe('mindSection', () => {
  it('composes the four panels and the DNA line', () => {
    const html = mindSection(snapshot(), { nowMs: NOW });
    for (const t of ['Direction', 'Knowledge', 'Frontier', 'Dispatches']) expect(html).toContain(t);
    expect(html).toContain('curio-dna');
  });
});

describe('config form', () => {
  it('previewDials overlays explicit dials on the preset', () => {
    expect(previewDials('focused', { topic: 'open' })).toEqual({
      ...TS_PRESETS.focused,
      topic: 'open',
    });
    expect(previewDials('', {})).toEqual(TS_PRESETS.explorer);
  });

  it('renders the preset, six dials with help text, the slider and dispatch fields', () => {
    const html = curiosityFormSection({
      preset: 'wild',
      limits: { topic: 'closed' },
      exploreRatio: 0.4,
    });
    expect(html).toMatch(/<option value="wild" selected/);
    for (const d of LIMIT_DIALS) expect(html).toContain(`name="curiosityDial_${d}"`);
    expect(html).toMatch(/name="curiosityDial_topic"[\s\S]*?<option value="closed" selected/);
    expect(html).toContain(DIAL_MEANINGS.topic.closed);
    expect(html).toContain('type="range"');
    expect(html).toContain('value="0.4"');
    expect(html).toContain('name="curiosityDispatchMaxChars"');
  });

  it('readCuriosityForm builds the override and keeps keys the form does not show', () => {
    const out = readCuriosityForm(
      {
        enabled: '',
        preset: 'focused',
        dials: {
          topic: 'ask',
          purpose: '',
          instructions: '',
          method: '',
          capability: '',
          identity: '',
        },
        exploreInherit: false,
        exploreRatio: '0.35',
        dispatchEnabled: 'false',
        dispatchMaxChars: '900',
      },
      { navigatorEvery: '2d', limits: { identity: 'open' }, dispatch: { minEditorScore: 0.8 } }
    );
    expect(out).toEqual({
      navigatorEvery: '2d',
      preset: 'focused',
      limits: { topic: 'ask' },
      exploreRatio: 0.35,
      dispatch: { minEditorScore: 0.8, enabled: false, maxChars: 900 },
    });
  });

  it('returns null when nothing is overridden (clear the block)', () => {
    expect(
      readCuriosityForm(
        {
          enabled: '',
          preset: '',
          dials: {},
          exploreInherit: true,
          exploreRatio: '0.25',
          dispatchEnabled: '',
          dispatchMaxChars: '',
        },
        { preset: 'wild', exploreRatio: 0.5 }
      )
    ).toBeNull();
  });

  it('clamps the explore ratio to 0–0.6 and the max chars to 200–4000', () => {
    const out = readCuriosityForm(
      {
        enabled: 'true',
        preset: '',
        dials: {},
        exploreInherit: false,
        exploreRatio: '0.9',
        dispatchEnabled: '',
        dispatchMaxChars: '50',
      },
      undefined
    );
    expect(out).toEqual({ enabled: true, exploreRatio: 0.6, dispatch: { maxChars: 200 } });
  });
});

describe('curiositySummary', () => {
  it('says global defaults when nothing is overridden', () => {
    expect(curiositySummary(undefined)).toBe('global defaults');
    expect(curiositySummary({})).toBe('global defaults');
  });
  it('lists the overrides', () => {
    expect(
      curiositySummary({
        preset: 'wild',
        limits: { topic: 'ask' },
        exploreRatio: 0.35,
        dispatch: { maxChars: 900 },
      })
    ).toBe('preset wild · topic ask · explore 35% · dispatch ≤ 900 chars');
    expect(curiositySummary({ dispatch: { enabled: false } })).toBe(
      'preset inherited · dispatches off'
    );
  });
  it('says off when disabled', () => {
    expect(curiositySummary({ enabled: false, preset: 'wild' })).toBe('off');
  });
});

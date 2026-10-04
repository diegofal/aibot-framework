import { describe, expect, it } from 'bun:test';
import { CURIOSITY_PRESETS, resolveCuriosity } from '../../../src/bot/curiosity/config';
import { emptyKnowledgeMap } from '../../../src/bot/curiosity/knowledge-map';
import {
  NAVIGATOR_CAPS,
  applyNavigatorResult,
  buildNavigatorPrompt,
  parseNavigatorResult,
  runNavigator,
  shouldRunNavigator,
} from '../../../src/bot/curiosity/navigator';
import type { NavigatorPromptInput, NavigatorResult } from '../../../src/bot/curiosity/navigator';
import { emptyNavigatorState } from '../../../src/bot/curiosity/store';
import type {
  Dispatch,
  FrontierItem,
  KnowledgeMap,
  NavigatorState,
} from '../../../src/bot/curiosity/types';
import type { LLMClient } from '../../../src/core/llm-client';

const NOW = '2026-10-03T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

const logger: any = {
  warn: () => {},
  info: () => {},
  debug: () => {},
  error: () => {},
};

const fi = (id: string, over: Partial<FrontierItem> = {}): FrontierItem => ({
  id,
  question: `Question ${id} about something specific`,
  whyInteresting: 'w',
  bridge: 'b',
  distance: 1,
  surpriseScore: 0.5,
  createdAt: '2026-10-01T00:00:00Z',
  status: 'open',
  ...over,
});

const mapWith = (frontier: FrontierItem[], over: Partial<KnowledgeMap> = {}): KnowledgeMap => ({
  ...emptyKnowledgeMap(),
  frontier,
  ...over,
});

const navWith = (over: Partial<NavigatorState> = {}): NavigatorState => ({
  ...emptyNavigatorState(),
  ...over,
});

const result = (over: Partial<NavigatorResult> = {}): NavigatorResult => ({
  retrospective: 'I wrote three harness notes; two landed.',
  learned: ['retries inflate pass@1'],
  surprised: ['k=8 beats a stronger model'],
  direction: {
    summary: 'Go from harness noise to reranker variance.',
    bets: [
      { title: 'Finish the harness note', kind: 'exploit', rationale: 'operator liked it' },
      { title: 'Rerankers', kind: 'explore', rationale: 'could invert rankings', frontierId: 'f1' },
    ],
  },
  frontierAdd: [],
  frontierDrop: [],
  servedDirectiveIds: [],
  interests: [],
  goalOperations: [],
  ...over,
});

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'd1',
  botId: 'b',
  createdAt: '2026-10-02T00:00:00Z',
  kind: 'insight',
  topic: 'Harness evaluation',
  hook: 'Retry harnesses lie',
  whyCare: 'w',
  evidence: 'e',
  action: 'a',
  body: 'body',
  editorScore: 0.8,
  status: 'sent',
  ...over,
});

const explorer = CURIOSITY_PRESETS.explorer;

const promptInput = (over: Partial<NavigatorPromptInput> = {}): NavigatorPromptInput => ({
  identity: 'I am Evalbot',
  soul: 'Careful and curious',
  motivations: 'Make evals honest',
  goals: '- [ ] Ship harness note',
  knowledge: '## What You Have Learned\n- KNOWLEDGE-MARKER',
  frontier: '## Frontier\n- [f1] FRONTIER-MARKER',
  directives: '## Operator Instructions\n- [x1] DIRECTIVE-MARKER',
  taste: '## What lands with the operator\nTASTE-MARKER',
  recentDispatches: [dispatch({ signal: 'up' }), dispatch({ id: 'd2', hook: 'Silent hook' })],
  cycleLog: [
    { at: NOW, topic: 'harness', mode: 'exploit', surprised: true },
    { at: NOW, topic: 'harness', mode: 'exploit', surprised: false },
    { at: NOW, topic: 'rerankers', mode: 'explore', surprised: true },
  ],
  concentration: { dominantTopic: 'harness', share: 2 / 3, count: 2, window: 3 },
  previousDirection: {
    at: '2026-10-02T00:00:00Z',
    summary: 'PREVIOUS-SUMMARY',
    retrospective: 'r',
    bets: [{ id: 'b1', title: 'PREVIOUS-BET', kind: 'explore', rationale: 'x' }],
    operatorSignal: 'down',
  },
  limits: explorer,
  datetime: NOW,
  ...over,
});

// ── shouldRunNavigator ─────────────────────────────────────────────────

describe('shouldRunNavigator', () => {
  const cfg = resolveCuriosity(undefined, undefined);

  it('is false when curiosity is disabled', () => {
    expect(shouldRunNavigator(navWith(), { ...cfg, enabled: false }, NOW_MS)).toBe(false);
  });

  it('is true when it never ran', () => {
    expect(shouldRunNavigator(navWith({ lastNavigatorAt: null }), cfg, NOW_MS)).toBe(true);
  });

  it('is true once the interval has elapsed', () => {
    const last = new Date(NOW_MS - cfg.navigatorEveryMs).toISOString();
    expect(shouldRunNavigator(navWith({ lastNavigatorAt: last }), cfg, NOW_MS)).toBe(true);
  });

  it('is false before the interval has elapsed', () => {
    const last = new Date(NOW_MS - cfg.navigatorEveryMs + 60_000).toISOString();
    expect(shouldRunNavigator(navWith({ lastNavigatorAt: last }), cfg, NOW_MS)).toBe(false);
  });

  it('treats an unparseable timestamp as due', () => {
    expect(shouldRunNavigator(navWith({ lastNavigatorAt: 'garbage' }), cfg, NOW_MS)).toBe(true);
  });
});

// ── buildNavigatorPrompt ───────────────────────────────────────────────

describe('buildNavigatorPrompt', () => {
  it('embeds the DNA section with the dials', () => {
    const { system } = buildNavigatorPrompt(promptInput());
    expect(system).toContain('## Your DNA');
    expect(system).toContain('- topic: OPEN');
    expect(system).toContain('- identity: CLOSED');
  });

  it('includes identity, knowledge, frontier, directives, taste and soul', () => {
    const { system, prompt: body } = buildNavigatorPrompt(promptInput());
    const prompt = `${system}
${body}`;
    for (const marker of [
      'KNOWLEDGE-MARKER',
      'FRONTIER-MARKER',
      'DIRECTIVE-MARKER',
      'TASTE-MARKER',
      'I am Evalbot',
      'Make evals honest',
      'Ship harness note',
    ]) {
      expect(prompt).toContain(marker);
    }
  });

  it('summarises the cycle log: topic counts, mix, surprise rate, concentration', () => {
    const { prompt } = buildNavigatorPrompt(promptInput());
    expect(prompt).toContain('harness ×2');
    expect(prompt).toContain('rerankers ×1');
    expect(prompt).toContain('1 explore / 2 exploit');
    expect(prompt).toContain('2/3');
    expect(prompt).toContain('67%');
  });

  it('lists recent dispatches with their operator signals', () => {
    const { prompt } = buildNavigatorPrompt(promptInput());
    expect(prompt).toContain('Retry harnesses lie');
    expect(prompt).toMatch(/Retry harnesses lie[^\n]*up/);
    expect(prompt).toMatch(/Silent hook[^\n]*none/);
  });

  it('includes the previous direction and its operator verdict', () => {
    const { prompt } = buildNavigatorPrompt(promptInput());
    expect(prompt).toContain('PREVIOUS-SUMMARY');
    expect(prompt).toContain('PREVIOUS-BET');
    expect(prompt).toMatch(/verdict[^\n]*rejected/i);
  });

  it('says when there is no previous direction or no history', () => {
    const { prompt } = buildNavigatorPrompt(
      promptInput({
        previousDirection: null,
        cycleLog: [],
        recentDispatches: [],
        concentration: { dominantTopic: null, share: 0, count: 0, window: 0 },
      })
    );
    expect(prompt).toContain('first direction');
    expect(prompt).toContain('no cycles recorded');
    expect(prompt).toContain('no dispatches');
  });

  it('instructs: explore bet, frontier ids, JSON, honesty, drops, distance/bridge', () => {
    const { prompt } = buildNavigatorPrompt(promptInput());
    expect(prompt).toContain('"explore"');
    expect(prompt).toContain('frontierId');
    expect(prompt).toMatch(/ONLY.*JSON/);
    expect(prompt).toMatch(/did NOT work/);
    expect(prompt).toContain('frontier_drop');
    expect(prompt).toContain('distance');
    expect(prompt).toContain('bridge');
    expect(prompt).toContain('surpriseScore');
    expect(prompt).toContain('goal_operations');
    expect(prompt).toContain(NOW);
  });

  it('asks for interests only when the identity dial is not closed', () => {
    const closed = buildNavigatorPrompt(promptInput()).prompt;
    expect(closed).toMatch(/identity dial is CLOSED/);
    const open = buildNavigatorPrompt(
      promptInput({ limits: { ...explorer, identity: 'open' } })
    ).prompt;
    expect(open).not.toMatch(/identity dial is CLOSED/);
    expect(open).toContain('interests');
  });

  it('lets the bot skip the explore bet only when topic and purpose are both closed', () => {
    const focused = buildNavigatorPrompt(
      promptInput({ limits: CURIOSITY_PRESETS.focused })
    ).prompt;
    expect(focused).toMatch(/inside your field/i);
    const exp = buildNavigatorPrompt(promptInput()).prompt;
    expect(exp).toMatch(/At least one bet MUST be "explore"/);
  });
});

// ── parseNavigatorResult ───────────────────────────────────────────────

const validJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    retrospective: 'did things',
    learned: ['a'],
    surprised: ['b'],
    direction: {
      summary: 'go there',
      bets: [{ title: 'Bet', kind: 'explore', rationale: 'why', frontierId: 'f1' }],
    },
    frontierAdd: [
      { question: 'New Q?', whyInteresting: 'w', bridge: 'br', distance: 1, surpriseScore: 0.6 },
    ],
    frontierDrop: ['f2'],
    servedDirectiveIds: ['x1'],
    interests: ['eval sociology'],
    goalOperations: [{ action: 'complete', goal: 'Track my own karma' }],
    ...over,
  });

describe('parseNavigatorResult', () => {
  it('parses camelCase output', () => {
    const r = parseNavigatorResult(validJson(), logger);
    expect(r).not.toBeNull();
    expect(r!.retrospective).toBe('did things');
    expect(r!.direction.bets[0]).toEqual({
      title: 'Bet',
      kind: 'explore',
      rationale: 'why',
      frontierId: 'f1',
    });
    expect(r!.frontierAdd[0].question).toBe('New Q?');
    expect(r!.frontierDrop).toEqual(['f2']);
    expect(r!.servedDirectiveIds).toEqual(['x1']);
    expect(r!.interests).toEqual(['eval sociology']);
    expect(r!.goalOperations).toEqual([{ action: 'complete', goal: 'Track my own karma' }]);
  });

  it('accepts snake_case keys', () => {
    const raw = JSON.stringify({
      retrospective: 'r',
      direction: { summary: 's', bets: [{ title: 't', kind: 'exploit', rationale: 'x', frontier_id: 'f9' }] },
      frontier_add: [
        { question: 'Q?', why_interesting: 'w', distance: 2, surprise_score: 0.9, from_topic: 'harness' },
      ],
      frontier_drop: ['f3'],
      served_directive_ids: ['x2'],
      goal_operations: [{ action: 'add', goal: 'g', priority: 'high' }],
    });
    const r = parseNavigatorResult(raw, logger)!;
    expect(r.direction.bets[0].frontierId).toBe('f9');
    expect(r.frontierAdd[0]).toMatchObject({
      question: 'Q?',
      whyInteresting: 'w',
      distance: 2,
      surpriseScore: 0.9,
      fromTopic: 'harness',
    });
    expect(r.frontierAdd[0].bridge).toBeUndefined();
    expect(r.frontierDrop).toEqual(['f3']);
    expect(r.servedDirectiveIds).toEqual(['x2']);
    expect(r.goalOperations[0]).toMatchObject({ action: 'add', goal: 'g', priority: 'high' });
    expect(r.learned).toEqual([]);
  });

  it('strips markdown fences and surrounding prose', () => {
    expect(parseNavigatorResult('```json\n' + validJson() + '\n```', logger)).not.toBeNull();
    expect(parseNavigatorResult('Here you go:\n' + validJson() + '\nthanks', logger)).not.toBeNull();
  });

  it('returns null on non-JSON', () => {
    expect(parseNavigatorResult('not json at all', logger)).toBeNull();
  });

  it('returns null without retrospective, summary or a valid bet', () => {
    expect(parseNavigatorResult(validJson({ retrospective: '' }), logger)).toBeNull();
    expect(parseNavigatorResult(validJson({ direction: { summary: '', bets: [] } }), logger)).toBeNull();
    expect(
      parseNavigatorResult(validJson({ direction: { summary: 's', bets: [] } }), logger)
    ).toBeNull();
    expect(
      parseNavigatorResult(
        validJson({ direction: { summary: 's', bets: [{ title: '', kind: 'explore' }] } }),
        logger
      )
    ).toBeNull();
  });

  it('caps bets at 3 and frontierAdd at 6', () => {
    const bets = Array.from({ length: 5 }, (_, i) => ({ title: `b${i}`, kind: 'exploit', rationale: 'r' }));
    const adds = Array.from({ length: 9 }, (_, i) => ({
      question: `q${i}`,
      whyInteresting: 'w',
      distance: 1,
      surpriseScore: 0.5,
    }));
    const r = parseNavigatorResult(
      validJson({ direction: { summary: 's', bets }, frontierAdd: adds }),
      logger
    )!;
    expect(r.direction.bets).toHaveLength(NAVIGATOR_CAPS.bets);
    expect(NAVIGATOR_CAPS.bets).toBe(3);
    expect(r.frontierAdd).toHaveLength(NAVIGATOR_CAPS.frontierAdd);
    expect(NAVIGATOR_CAPS.frontierAdd).toBe(6);
  });

  it('coerces and clamps numbers, defaults unknown bet kinds to exploit', () => {
    const r = parseNavigatorResult(
      validJson({
        direction: { summary: 's', bets: [{ title: 't', kind: 'wander', rationale: 'r' }] },
        frontierAdd: [
          { question: 'a', whyInteresting: 'w', distance: '7', surpriseScore: '1.8' },
          { question: 'b', whyInteresting: 'w', distance: -2, surpriseScore: -1 },
          { question: 'c', whyInteresting: 'w', distance: 'far', surpriseScore: 'lots' },
          { question: 'd', whyInteresting: 'w', distance: 1.6, surpriseScore: 0.4 },
        ],
      }),
      logger
    )!;
    expect(r.direction.bets[0].kind).toBe('exploit');
    expect(r.frontierAdd.map((f) => [f.distance, f.surpriseScore])).toEqual([
      [5, 1],
      [0, 0],
      [1, 0.5],
      [2, 0.4],
    ]);
  });

  it('drops malformed entries', () => {
    const r = parseNavigatorResult(
      validJson({
        learned: ['ok', 3, '', null],
        frontierAdd: [{ whyInteresting: 'no question' }, 'string', { question: 'ok?' }],
        frontierDrop: ['f1', 4, ''],
        servedDirectiveIds: 'not-an-array',
        interests: [' grown ', {}],
        goalOperations: [{ action: 'explode', goal: 'g' }, { action: 'add' }, { action: 'remove', goal: 'r' }],
      }),
      logger
    )!;
    expect(r.learned).toEqual(['ok']);
    expect(r.frontierAdd.map((f) => f.question)).toEqual(['ok?']);
    expect(r.frontierAdd[0].whyInteresting).toBe('');
    expect(r.frontierDrop).toEqual(['f1']);
    expect(r.servedDirectiveIds).toEqual([]);
    expect(r.interests).toEqual(['grown']);
    expect(r.goalOperations).toEqual([{ action: 'remove', goal: 'r' }]);
  });
});

// ── applyNavigatorResult ───────────────────────────────────────────────

describe('applyNavigatorResult', () => {
  const base = () => ({
    map: mapWith([fi('f1'), fi('f2'), fi('f3', { question: 'Unrelated other question here' })]),
    nav: navWith({
      directives: [
        { id: 'x1', text: 'do evals', source: 'message', receivedAt: NOW, servedOutputs: 1, status: 'active' },
        { id: 'x2', text: 'other', source: 'message', receivedAt: NOW, servedOutputs: 0, status: 'active' },
      ],
    }),
  });

  it('sets the direction with generated bet ids and lastNavigatorAt', () => {
    const { map, nav } = base();
    const out = applyNavigatorResult({ map, nav, result: result(), limits: explorer, now: NOW });
    expect(out.nav.lastNavigatorAt).toBe(NOW);
    expect(out.nav.direction?.at).toBe(NOW);
    expect(out.nav.direction?.summary).toBe('Go from harness noise to reranker variance.');
    expect(out.nav.direction?.retrospective).toContain('two landed');
    expect(out.nav.direction?.bets).toHaveLength(2);
    const ids = out.nav.direction!.bets.map((b) => b.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(out.nav.direction?.operatorSignal).toBeUndefined();
  });

  it('does not mutate its inputs', () => {
    const { map, nav } = base();
    const mapBefore = structuredClone(map);
    const navBefore = structuredClone(nav);
    applyNavigatorResult({
      map,
      nav,
      result: result({ frontierDrop: ['f2'], servedDirectiveIds: ['x1'], interests: ['x'] }),
      limits: { ...explorer, identity: 'open' },
      now: NOW,
    });
    expect(map).toEqual(mapBefore);
    expect(nav).toEqual(navBefore);
  });

  it('marks served directives and ignores unknown ids', () => {
    const { map, nav } = base();
    const out = applyNavigatorResult({
      map,
      nav,
      result: result({ servedDirectiveIds: ['x1', 'nope'] }),
      limits: explorer,
      now: NOW,
    });
    const x1 = out.nav.directives.find((d) => d.id === 'x1')!;
    const x2 = out.nav.directives.find((d) => d.id === 'x2')!;
    expect(x1.status).toBe('served');
    expect(x1.servedAt).toBe(NOW);
    expect(x2.status).toBe('active');
    expect(out.nav.directives).toHaveLength(2);
  });

  it('drops frontier items and ignores unknown ids', () => {
    const { map, nav } = base();
    const out = applyNavigatorResult({
      map,
      nav,
      result: result({ frontierDrop: ['f2', 'ghost'] }),
      limits: explorer,
      now: NOW,
    });
    expect(out.map.frontier.find((f) => f.id === 'f2')!.status).toBe('dropped');
    expect(out.map.frontier).toHaveLength(3);
  });

  it('marks a bet’s frontier item as exploring; unknown frontier ids are ignored', () => {
    const { map, nav } = base();
    const out = applyNavigatorResult({
      map,
      nav,
      result: result({
        direction: {
          summary: 's',
          bets: [
            { title: 'a', kind: 'explore', rationale: 'r', frontierId: 'f1' },
            { title: 'b', kind: 'explore', rationale: 'r', frontierId: 'ghost' },
          ],
        },
      }),
      limits: explorer,
      now: NOW,
    });
    expect(out.map.frontier.find((f) => f.id === 'f1')!.status).toBe('exploring');
    expect(out.map.frontier.filter((f) => f.status === 'exploring')).toHaveLength(1);
    expect(out.nav.direction!.bets[1].frontierId).toBe('ghost');
  });

  it('adds new frontier items as open with clamped numbers and a topic id', () => {
    const { map, nav } = base();
    const out = applyNavigatorResult({
      map,
      nav,
      result: result({
        frontierAdd: [
          {
            question: 'How do reranker choices shift eval variance at scale?',
            whyInteresting: 'w',
            bridge: 'evals',
            distance: 9,
            surpriseScore: 3,
            fromTopic: 'Harness Evaluation',
          },
        ],
      }),
      limits: explorer,
      now: NOW,
    });
    const added = out.map.frontier[out.map.frontier.length - 1];
    expect(out.map.frontier).toHaveLength(4);
    expect(added.status).toBe('open');
    expect(added.distance).toBe(5);
    expect(added.surpriseScore).toBe(1);
    expect(added.fromTopic).toBe('harness-evaluation');
    expect(added.createdAt).toBe(NOW);
    expect(added.id.length).toBeGreaterThan(0);
    expect(out.map.updatedAt).toBe(NOW);
  });

  it('dedupes frontier additions against existing and each other', () => {
    const { map, nav } = base();
    const out = applyNavigatorResult({
      map,
      nav,
      result: result({
        frontierAdd: [
          { question: 'Question f1 about something specific', whyInteresting: 'w', distance: 1, surpriseScore: 0.5 },
          { question: 'Brand new question on tokenizers', whyInteresting: 'w', distance: 1, surpriseScore: 0.5 },
          { question: 'brand new question on tokenizers', whyInteresting: 'w', distance: 1, surpriseScore: 0.5 },
        ],
      }),
      limits: explorer,
      now: NOW,
    });
    expect(out.map.frontier).toHaveLength(4);
  });

  it('identity open → interests are added to the map (deduped, capped at 12)', () => {
    const { nav } = base();
    const map = mapWith([], { interests: Array.from({ length: 11 }, (_, i) => `interest number ${i}`) });
    const out = applyNavigatorResult({
      map,
      nav,
      result: result({ interests: ['Interest number 3', 'eval sociology', 'compiler history'] }),
      limits: { ...explorer, identity: 'open' },
      now: NOW,
    });
    expect(out.map.interests).toHaveLength(12);
    expect(out.map.interests).toContain('compiler history');
    expect(out.map.interests.filter((i) => /number 3/i.test(i))).toHaveLength(1);
    expect(out.interestProposals).toEqual([]);
  });

  it('identity ask → interests are returned as proposals, map untouched', () => {
    const { map, nav } = base();
    const out = applyNavigatorResult({
      map,
      nav,
      result: result({ interests: ['eval sociology'] }),
      limits: { ...explorer, identity: 'ask' },
      now: NOW,
    });
    expect(out.interestProposals).toEqual(['eval sociology']);
    expect(out.map.interests).toEqual([]);
  });

  it('identity closed → interests are discarded', () => {
    const { map, nav } = base();
    const out = applyNavigatorResult({
      map,
      nav,
      result: result({ interests: ['eval sociology'] }),
      limits: explorer,
      now: NOW,
    });
    expect(out.interestProposals).toEqual([]);
    expect(out.map.interests).toEqual([]);
  });

  it('passes goal operations through', () => {
    const { map, nav } = base();
    const ops = [{ action: 'complete' as const, goal: 'Track my own karma', outcome: 'self-referential' }];
    const out = applyNavigatorResult({
      map,
      nav,
      result: result({ goalOperations: ops }),
      limits: explorer,
      now: NOW,
    });
    expect(out.goalOperations).toEqual(ops);
  });
});

// ── runNavigator ───────────────────────────────────────────────────────

function fakeClient(responses: string[]) {
  const calls: Array<{ prompt: string; opts: any }> = [];
  const client = {
    backend: 'ollama',
    async generate(prompt: string, opts: any) {
      calls.push({ prompt, opts });
      const text = responses[Math.min(calls.length - 1, responses.length - 1)];
      return {
        text,
        usage: { model: 'm', promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      };
    },
    async chat() {
      throw new Error('unused');
    },
  } as unknown as LLMClient;
  return { client, calls };
}

describe('runNavigator', () => {
  it('returns the parsed result with usage on the first try at temperature 0.7', async () => {
    const { client, calls } = fakeClient([validJson()]);
    const r = await runNavigator(client, promptInput(), 'model-x', logger);
    expect(r).not.toBeNull();
    expect(r!.direction.summary).toBe('go there');
    expect(r!.usage?.totalTokens).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.temperature).toBe(0.7);
    expect(calls[0].opts.model).toBe('model-x');
    expect(calls[0].opts.system).toContain('## Your DNA');
  });

  it('retries once at 0.3 when the first output does not parse', async () => {
    const { client, calls } = fakeClient(['garbage', validJson()]);
    const r = await runNavigator(client, promptInput(), 'm', logger);
    expect(r).not.toBeNull();
    expect(calls.map((c) => c.opts.temperature)).toEqual([0.7, 0.3]);
  });

  it('returns null (never throws) when both attempts fail to parse', async () => {
    const { client, calls } = fakeClient(['garbage', 'still garbage']);
    const r = await runNavigator(client, promptInput(), 'm', logger);
    expect(r).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('propagates LLM errors', async () => {
    const client = {
      backend: 'ollama',
      generate: async () => {
        throw new Error('boom');
      },
    } as unknown as LLMClient;
    await expect(runNavigator(client, promptInput(), 'm', logger)).rejects.toThrow('boom');
  });
});


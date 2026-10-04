import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mergeExtraction } from '../../../src/bot/curiosity/knowledge-map';
import { beginCuriosityCycle, finishCuriosityCycle } from '../../../src/bot/curiosity/runner';
import type { CuriosityCycle, RunnerDeps } from '../../../src/bot/curiosity/runner';
import { CuriosityService } from '../../../src/bot/curiosity/service';
import type { CuriosityConfig } from '../../../src/config';

const ROOT = join(import.meta.dir, '.tmp-curiosity-runner');
const NOW = '2026-10-03T12:00:00.000Z';
const logger = { warn() {}, info() {}, debug() {}, error() {} } as any;

const navigatorJson = JSON.stringify({
  retrospective: 'Too much harness work.',
  learned: ['x'],
  surprised: [],
  direction: {
    summary: 'Move into retrieval economics',
    bets: [{ title: 'Rerankers', kind: 'explore', rationale: 'unknown territory' }],
  },
  frontier_add: [
    {
      question: 'Are rerankers cheaper than bigger embeddings?',
      why_interesting: 'may flip default advice',
      bridge: 'operator picks models',
      distance: 1,
      surprise_score: 0.8,
    },
  ],
  frontier_drop: [],
  served_directive_ids: [],
  interests: [],
  goal_operations: [],
});

const extractorJson = (dispatch: unknown = null) =>
  JSON.stringify({
    topic: 'Retrieval reranking',
    findings: [{ claim: 'Reranking lifts top-1 5→18%', evidence: 'p/22.ts', confidence: 'medium' }],
    surprises: ['a small reranker beat a big embedding'],
    open_questions: [],
    frontier: [],
    served_directive_ids: [],
    no_surprise: false,
    dispatch,
  });

const editorJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    insight: 0.9,
    novelty: 0.9,
    backed: 0.9,
    verdict: 'send',
    notes: 'good',
    ...over,
  });

/** Fake LLM that answers by recognising which prompt it got. */
function fakeLLM(answers: { navigator?: string; extractor?: string; editor?: string }) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      generate: async (_prompt: string, opts: { system?: string }) => {
        const sys = opts.system ?? '';
        if (/distill one work cycle/i.test(sys)) {
          calls.push('extractor');
          return { text: answers.extractor ?? 'nope' };
        }
        if (/editor/i.test(sys)) {
          calls.push('editor');
          return { text: answers.editor ?? 'nope' };
        }
        calls.push('navigator');
        return { text: answers.navigator ?? 'nope' };
      },
    } as any,
  };
}

describe('curiosity runner', () => {
  let botCfg: CuriosityConfig;
  let svc: CuriosityService;
  let delivered: string[];
  let deps: (llm: ReturnType<typeof fakeLLM>, over?: Partial<RunnerDeps>) => RunnerDeps;

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    botCfg = {};
    svc = new CuriosityService({
      getSoulDir: (id) => join(ROOT, id),
      getCuriosityInputs: () => ({ global: undefined, bot: botCfg }),
      now: () => NOW,
    });
    delivered = [];
    deps = (llm, over = {}) => ({
      service: svc,
      llm: { client: llm.client, model: 'm' },
      logger,
      deliver: async (_botId, text) => {
        delivered.push(text);
        return 'telegram' as const;
      },
      applyGoalOperations: () => {},
      now: () => NOW,
      ...over,
    });
  });
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  const soul = { identity: 'AI Perfectionist', soul: 'S', motivations: 'M', goals: 'G' };

  it('returns null when curiosity is disabled', async () => {
    botCfg = { enabled: false };
    const llm = fakeLLM({});
    expect(
      await beginCuriosityCycle(deps(llm), { botId: 'b', ...soul, answered: [], feedback: [] })
    ).toBeNull();
    expect(llm.calls).toEqual([]);
  });

  it('first cycle runs the navigator, persists direction + frontier, builds the DNA block', async () => {
    const llm = fakeLLM({ navigator: navigatorJson });
    const cycle = (await beginCuriosityCycle(deps(llm), {
      botId: 'b',
      ...soul,
      answered: [],
      feedback: [],
    }))!;
    expect(cycle.navigatorStarted).toBe(true);
    expect(cycle.curiosityBlock).toContain('## Your DNA');
    await svc.waitForNavigator('b');
    expect(llm.calls).toEqual(['navigator']);
    const store = svc.storeFor('b')!;
    expect(store.loadNavigator().direction?.summary).toBe('Move into retrieval economics');
    expect(store.loadMap().frontier).toHaveLength(1);
    // The next cycle reads the direction the background run landed.
    const next = (await beginCuriosityCycle(deps(llm), {
      botId: 'b',
      ...soul,
      answered: [],
      feedback: [],
    }))!;
    expect(next.curiosityBlock).toContain('Move into retrieval economics');
  });

  it('does not rerun the navigator before it is due', async () => {
    const llm = fakeLLM({ navigator: navigatorJson });
    await beginCuriosityCycle(deps(llm), { botId: 'b', ...soul, answered: [], feedback: [] });
    await svc.waitForNavigator('b');
    const second = (await beginCuriosityCycle(deps(llm), {
      botId: 'b',
      ...soul,
      answered: [],
      feedback: [],
    }))!;
    expect(second.navigatorStarted).toBe(false);
    expect(llm.calls).toEqual(['navigator']);
  });

  it('survives a navigator failure', async () => {
    const llm = {
      calls: [] as string[],
      client: {
        generate: async () => {
          throw new Error('429');
        },
      } as any,
    };
    const cycle = await beginCuriosityCycle(deps(llm), {
      botId: 'b',
      ...soul,
      answered: [],
      feedback: [],
    });
    expect(cycle).not.toBeNull();
    await svc.waitForNavigator('b');
    expect(svc.storeFor('b')!.loadNavigator().direction).toBeNull();
  });

  it('records answered asks and feedback as directives', async () => {
    const llm = fakeLLM({ navigator: navigatorJson });
    await beginCuriosityCycle(deps(llm), {
      botId: 'b',
      ...soul,
      answered: [{ question: 'Which thread next?', answer: 'Go deep on retrieval' }],
      feedback: ['Shorter messages please, lead with the claim'],
    });
    const texts = svc
      .storeFor('b')!
      .loadNavigator()
      .directives.map((d) => d.text);
    expect(texts.some((t) => t.includes('Go deep on retrieval'))).toBe(true);
    expect(texts.some((t) => t.includes('Shorter messages'))).toBe(true);
  });

  it('an explore cycle targets an allowed frontier item and marks it exploring', async () => {
    const store = svc.storeFor('b')!;
    const nav = store.loadNavigator();
    nav.lastNavigatorAt = NOW;
    nav.cyclesSinceExplore = 10;
    store.saveNavigator(nav);
    store.saveMap(
      mergeExtraction(
        store.loadMap(),
        {
          topic: 'harness',
          findings: [],
          surprises: [],
          openQuestions: [],
          frontier: [
            {
              question: 'Why do rerankers win?',
              whyInteresting: 'w',
              bridge: 'b',
              distance: 1,
              surpriseScore: 0.9,
            },
          ],
          servedDirectiveIds: [],
          noSurprise: false,
        },
        NOW
      )
    );
    const cycle = (await beginCuriosityCycle(deps(fakeLLM({})), {
      botId: 'b',
      ...soul,
      answered: [],
      feedback: [],
    }))!;
    expect(cycle.decision.mode).toBe('explore');
    expect(cycle.frontierItem?.question).toBe('Why do rerankers win?');
    expect(cycle.curiosityBlock).toContain('EXPLORATION CYCLE');
    expect(store.loadMap().frontier[0].status).toBe('exploring');
  });

  async function begun(llm: ReturnType<typeof fakeLLM>): Promise<CuriosityCycle> {
    const store = svc.storeFor('b')!;
    const nav = store.loadNavigator();
    nav.lastNavigatorAt = NOW; // navigator not due
    store.saveNavigator(nav);
    return (await beginCuriosityCycle(deps(llm), {
      botId: 'b',
      ...soul,
      answered: [],
      feedback: [],
    }))!;
  }

  const finishArgs = (cycle: CuriosityCycle) => ({
    botId: 'b',
    botName: 'AI Perfectionist',
    identity: 'AI Perfectionist',
    cycle,
    deliverable: 'Write a reranking eval',
    plan: ['Write eval'],
    summary: 'Wrote p/22.ts',
    toolCalls: [{ name: 'file_write', args: { path: 'productions/22.ts' }, success: true }],
  });

  it('finish merges knowledge, records the cycle, and skips dispatch without a candidate', async () => {
    const llm = fakeLLM({ extractor: extractorJson() });
    const cycle = await begun(llm);
    const r = await finishCuriosityCycle(deps(llm), finishArgs(cycle));
    expect(r.extracted).toBe(true);
    expect(r.dispatch).toBeUndefined();
    const store = svc.storeFor('b')!;
    const map = store.loadMap();
    expect(map.topics[0].name).toBe('Retrieval reranking');
    expect(map.topics[0].outputs).toEqual(['productions/22.ts']);
    expect(store.loadNavigator().cycleLog.at(-1)).toMatchObject({
      topic: 'retrieval-reranking',
      surprised: true,
    });
    expect(llm.calls).toEqual(['extractor']);
  });

  it('finish sends an insight the editor approves, and closes the cadence', async () => {
    const llm = fakeLLM({
      extractor: extractorJson({
        hook: 'A tiny reranker beat a 4x bigger embedding model',
        why_care: 'you are choosing embeddings',
        evidence: '5→18% top-1',
        action: 'try a reranker first',
      }),
      editor: editorJson(),
    });
    const cycle = await begun(llm);
    const r = await finishCuriosityCycle(deps(llm), finishArgs(cycle));
    expect(r.dispatch?.status).toBe('sent');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('A tiny reranker beat a 4x bigger embedding model');
    const store = svc.storeFor('b')!;
    expect(store.listDispatches()[0].status).toBe('sent');
    expect(store.loadTaste().cadence.lastSentAt).toBe(NOW);
  });

  it('finish holds an insight the editor scores low', async () => {
    const llm = fakeLLM({
      extractor: extractorJson({ hook: 'Meh', why_care: 'w', evidence: 'e', action: 'a' }),
      editor: editorJson({ insight: 0.2, novelty: 0.2, verdict: 'hold' }),
    });
    const cycle = await begun(llm);
    const r = await finishCuriosityCycle(deps(llm), finishArgs(cycle));
    expect(r.dispatch?.status).toBe('held');
    expect(delivered).toHaveLength(0);
  });

  it('finish holds when delivery fails', async () => {
    const llm = fakeLLM({
      extractor: extractorJson({
        hook: 'Real insight here',
        why_care: 'w',
        evidence: 'e',
        action: 'a',
      }),
      editor: editorJson(),
    });
    const cycle = await begun(llm);
    const r = await finishCuriosityCycle(
      deps(llm, { deliver: async () => false as const }),
      finishArgs(cycle)
    );
    expect(r.dispatch?.status).toBe('held');
  });

  it('finish does nothing for idle cycles or a failed extraction', async () => {
    const llm = fakeLLM({});
    const cycle = await begun(llm);
    expect(
      (await finishCuriosityCycle(deps(llm), { ...finishArgs(cycle), idle: true })).extracted
    ).toBe(false);
    expect(llm.calls).toEqual([]);
    const r = await finishCuriosityCycle(deps(llm), finishArgs(cycle));
    expect(r.extracted).toBe(false);
    expect(svc.storeFor('b')!.loadNavigator().cycleLog).toHaveLength(0);
  });

  it('respects the fleet limiter', async () => {
    const llm = fakeLLM({
      extractor: extractorJson({
        hook: 'Real insight here',
        why_care: 'w',
        evidence: 'e',
        action: 'a',
      }),
      editor: editorJson(),
    });
    const cycle = await begun(llm);
    const r = await finishCuriosityCycle(
      deps(llm, { fleetAllows: () => false }),
      finishArgs(cycle)
    );
    expect(r.dispatch?.status).toBe('held');
    expect(delivered).toHaveLength(0);
  });
});

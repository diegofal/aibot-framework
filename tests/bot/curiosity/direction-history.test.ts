/**
 * Navigator direction history (DIRECTIONS.jsonl) and frontier provenance:
 * which run or cycle added a frontier item and why one was dropped. Only what
 * the navigator / extractor / operator produced at the time is stored.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  emptyKnowledgeMap,
  mergeExtraction,
  setFrontierSignal,
} from '../../../src/bot/curiosity/knowledge-map';
import {
  type NavigatorResult,
  applyNavigatorResult,
  navigatorTrigger,
} from '../../../src/bot/curiosity/navigator';
import { beginCuriosityCycle, finishCuriosityCycle } from '../../../src/bot/curiosity/runner';
import type { RunnerDeps } from '../../../src/bot/curiosity/runner';
import { CuriosityService } from '../../../src/bot/curiosity/service';
import {
  CURIOSITY_FILES,
  CuriosityStore,
  DIRECTION_KEEP,
  emptyNavigatorState,
} from '../../../src/bot/curiosity/store';
import type {
  DirectionRecord,
  FrontierItem,
  LimitDials,
  ResolvedCuriosity,
} from '../../../src/bot/curiosity/types';

const ROOT = join(import.meta.dir, '.tmp-direction-history');
const NOW = '2026-10-03T12:00:00.000Z';
const DAY = 86_400_000;
const logger = { warn() {}, info() {}, debug() {}, error() {} } as any;
const limits: LimitDials = {
  topic: 'open',
  purpose: 'open',
  instructions: 'open',
  method: 'open',
  capability: 'open',
  identity: 'open',
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

const result = (over: Partial<NavigatorResult> = {}): NavigatorResult => ({
  retrospective: 'Two notes landed, one went nowhere.',
  learned: ['retries inflate pass@1'],
  surprised: ['k=8 beats a stronger model'],
  direction: {
    summary: 'From harness noise to reranker variance.',
    bets: [{ title: 'Rerankers', kind: 'explore', rationale: 'could invert rankings' }],
  },
  frontierAdd: [
    {
      question: 'Do rerankers change the ranking of models?',
      whyInteresting: 'could flip advice',
      bridge: 'operator picks models',
      distance: 1,
      surpriseScore: 0.7,
    },
  ],
  frontierDrop: ['f1'],
  servedDirectiveIds: [],
  interests: [],
  goalOperations: [],
  ...over,
});

const record = (i: number): DirectionRecord => ({
  runId: `r${i}`,
  at: new Date(Date.parse(NOW) + i * 1000).toISOString(),
  summary: `s${i}`,
  retrospective: 'r',
  bets: [],
  learned: [],
  surprised: [],
  trigger: { kind: 'due', everyHours: 24 },
});

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('CuriosityStore directions', () => {
  it('appends to DIRECTIONS.jsonl and lists newest first', () => {
    const store = new CuriosityStore(join(ROOT, 'b'));
    expect(store.listDirections()).toEqual([]);
    store.appendDirection(record(1));
    store.appendDirection(record(2));
    expect(CURIOSITY_FILES.directions).toBe('DIRECTIONS.jsonl');
    expect(store.listDirections().map((d) => d.runId)).toEqual(['r2', 'r1']);
    expect(store.listDirections(1).map((d) => d.runId)).toEqual(['r2']);
  });

  it(`keeps the newest ${DIRECTION_KEEP}`, () => {
    const store = new CuriosityStore(join(ROOT, 'b'));
    for (let i = 0; i < DIRECTION_KEEP + 5; i++) store.appendDirection(record(i));
    const all = store.listDirections();
    expect(all).toHaveLength(DIRECTION_KEEP);
    expect(all[0].runId).toBe(`r${DIRECTION_KEEP + 4}`);
    expect(all.at(-1)?.runId).toBe('r5');
  });

  it('skips malformed lines', () => {
    const dir = join(ROOT, 'b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'DIRECTIONS.jsonl'),
      `not json\n${JSON.stringify(record(1))}\n{"x":1}\n`,
      'utf-8'
    );
    expect(new CuriosityStore(dir).listDirections().map((d) => d.runId)).toEqual(['r1']);
  });
});

describe('navigatorTrigger', () => {
  const cfg = { navigatorEveryMs: DAY } as ResolvedCuriosity;

  it('first run: never set a direction, never tried', () => {
    expect(navigatorTrigger(emptyNavigatorState(), cfg)).toEqual({ kind: 'first', everyHours: 24 });
  });

  it('due: the previous run landed', () => {
    const nav = {
      ...emptyNavigatorState(),
      lastNavigatorAt: '2026-10-02T10:00:00.000Z',
      lastNavigatorAttemptAt: '2026-10-02T10:00:00.000Z',
    };
    expect(navigatorTrigger(nav, cfg)).toEqual({
      kind: 'due',
      everyHours: 24,
      lastRunAt: '2026-10-02T10:00:00.000Z',
    });
  });

  it('retry: the last attempt is newer than the last landed run', () => {
    const nav = {
      ...emptyNavigatorState(),
      lastNavigatorAt: '2026-10-01T10:00:00.000Z',
      lastNavigatorAttemptAt: '2026-10-03T08:00:00.000Z',
    };
    expect(navigatorTrigger(nav, cfg)).toEqual({
      kind: 'retry',
      everyHours: 24,
      lastRunAt: '2026-10-01T10:00:00.000Z',
      failedAttemptAt: '2026-10-03T08:00:00.000Z',
    });
    const neverLanded = { ...emptyNavigatorState(), lastNavigatorAttemptAt: NOW };
    expect(navigatorTrigger(neverLanded, cfg).kind).toBe('retry');
  });
});

describe('applyNavigatorResult provenance', () => {
  const apply = () =>
    applyNavigatorResult({
      map: { ...emptyKnowledgeMap(), frontier: [fi('f1'), fi('f2')] },
      nav: emptyNavigatorState(),
      result: result(),
      limits,
      now: NOW,
      runId: 'run-1',
      trigger: { kind: 'first', everyHours: 24 },
    });

  it('returns the run as a direction record with learned / surprised and the trigger', () => {
    const out = apply();
    expect(out.record).toMatchObject({
      runId: 'run-1',
      at: NOW,
      summary: 'From harness noise to reranker variance.',
      retrospective: 'Two notes landed, one went nowhere.',
      learned: ['retries inflate pass@1'],
      surprised: ['k=8 beats a stronger model'],
      trigger: { kind: 'first', everyHours: 24 },
    });
    expect(out.record.bets[0]).toMatchObject({ title: 'Rerankers', kind: 'explore' });
    expect(out.nav.direction?.runId).toBe('run-1');
    expect(out.nav.direction?.bets).toEqual(out.record.bets);
  });

  it('stamps the run on the items it adds and drops', () => {
    const out = apply();
    const added = out.map.frontier.find((f) => f.question.startsWith('Do rerankers'));
    expect(added?.createdBy).toEqual({ by: 'navigator', runId: 'run-1', at: NOW });
    expect(out.map.frontier.find((f) => f.id === 'f1')).toMatchObject({
      status: 'dropped',
      droppedReason: { by: 'navigator', runId: 'run-1', at: NOW },
    });
    expect(out.map.frontier.find((f) => f.id === 'f2')?.droppedReason).toBeUndefined();
    expect(out.record.frontierAdded).toEqual([added?.id]);
    expect(out.record.frontierDropped).toEqual(['f1']);
  });

  it('makes up a run id when the caller gives none', () => {
    const out = applyNavigatorResult({
      map: emptyKnowledgeMap(),
      nav: emptyNavigatorState(),
      result: result({ frontierDrop: [] }),
      limits,
      now: NOW,
    });
    expect(out.record.runId).toMatch(/\S+/);
    expect(out.record.trigger).toBeUndefined();
  });
});

describe('frontier provenance outside the navigator', () => {
  const extraction = {
    topic: 'Rerank',
    findings: [],
    surprises: [],
    openQuestions: [],
    frontier: [
      { question: 'Is a reranker worth it?', whyInteresting: 'w', distance: 1, surpriseScore: 0.5 },
    ],
    servedDirectiveIds: [],
    noSurprise: true,
  };

  it('an extractor item names the cycle that produced it', () => {
    const map = mergeExtraction(emptyKnowledgeMap(), extraction as any, NOW, { cycleId: 'c-9' });
    expect(map.frontier[0].createdBy).toEqual({ by: 'extractor', cycleId: 'c-9', at: NOW });
    const anon = mergeExtraction(emptyKnowledgeMap(), extraction as any, NOW);
    expect(anon.frontier[0].createdBy).toEqual({ by: 'extractor', at: NOW });
  });

  it('an operator 👎 records the drop; 👍 clears it', () => {
    const map = { ...emptyKnowledgeMap(), frontier: [fi('f1')] };
    const down = setFrontierSignal(map, 'f1', 'down', { at: NOW, via: 'dispatch' })!;
    expect(down.frontier[0].droppedReason).toEqual({ by: 'operator', at: NOW, via: 'dispatch' });
    const up = setFrontierSignal(down, 'f1', 'up', { at: NOW })!;
    expect(up.frontier[0].status).toBe('open');
    expect(up.frontier[0].droppedReason).toBeUndefined();
  });

  it('old state without the fields still loads', () => {
    const dir = join(ROOT, 'old');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'KNOWLEDGE.json'),
      JSON.stringify({ ...emptyKnowledgeMap(), frontier: [fi('f1')] }),
      'utf-8'
    );
    const item = new CuriosityStore(dir).loadMap().frontier[0];
    expect(item.id).toBe('f1');
    expect(item.createdBy).toBeUndefined();
  });
});

describe('runner + service', () => {
  const navigatorJson = JSON.stringify({
    retrospective: 'Too much harness work.',
    learned: ['x'],
    surprised: ['y'],
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
  });
  const extractorJson = JSON.stringify({
    topic: 'Retrieval reranking',
    findings: [],
    surprises: [],
    open_questions: [],
    frontier: [{ question: 'Does a cross-encoder pay off?', why_interesting: 'w', distance: 1 }],
    no_surprise: true,
    dispatch: null,
  });

  let svc: CuriosityService;
  const deps = (navigator: string | null): RunnerDeps => ({
    service: svc,
    llm: {
      client: {
        generate: async (_p: string, opts: { system?: string }) => {
          if (/distill one work cycle/i.test(opts.system ?? '')) return { text: extractorJson };
          if (navigator === null) throw new Error('429');
          return { text: navigator };
        },
      } as any,
      model: 'm',
    },
    logger,
    deliver: async () => 'inbox' as const,
    applyGoalOperations: () => {},
    now: () => NOW,
  });
  const begin = (d: RunnerDeps) =>
    beginCuriosityCycle(d, {
      botId: 'b',
      identity: 'I',
      soul: 'S',
      motivations: 'M',
      goals: 'G',
      answered: [],
      feedback: [],
    });

  beforeEach(() => {
    svc = new CuriosityService({
      getSoulDir: (id) => join(ROOT, id),
      getCuriosityInputs: () => ({ global: undefined, bot: {} }),
      now: () => NOW,
    });
  });

  it('a landed navigator run appends one direction row and stamps its frontier items', async () => {
    await begin(deps(navigatorJson));
    await svc.waitForNavigator('b');
    const store = svc.storeFor('b')!;
    const [row] = store.listDirections();
    expect(row).toMatchObject({
      summary: 'Move into retrieval economics',
      learned: ['x'],
      surprised: ['y'],
      trigger: { kind: 'first' },
    });
    expect(store.loadNavigator().direction?.runId).toBe(row.runId);
    expect(store.loadMap().frontier[0].createdBy).toMatchObject({
      by: 'navigator',
      runId: row.runId,
    });
    const lines = readFileSync(join(ROOT, 'b', 'DIRECTIONS.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
  });

  it('a failed run writes no direction row; the next attempt says it is a retry', async () => {
    await begin(deps(null));
    await svc.waitForNavigator('b');
    expect(svc.storeFor('b')!.listDirections()).toEqual([]);
    // Past the backoff, the retry lands.
    const store = svc.storeFor('b')!;
    const nav = store.loadNavigator();
    nav.lastNavigatorAttemptAt = '2026-10-03T08:00:00.000Z';
    store.saveNavigator(nav);
    await begin(deps(navigatorJson));
    await svc.waitForNavigator('b');
    expect(store.listDirections()[0].trigger).toMatchObject({
      kind: 'retry',
      failedAttemptAt: '2026-10-03T08:00:00.000Z',
    });
  });

  it('finish stamps the cycle on the frontier items its extraction added', async () => {
    const store = svc.storeFor('b')!;
    store.saveNavigator({ ...emptyNavigatorState(), lastNavigatorAt: NOW });
    const cycle = (await begin(deps(navigatorJson)))!;
    await finishCuriosityCycle(deps(navigatorJson), {
      botId: 'b',
      botName: 'B',
      identity: 'I',
      cycle,
      deliverable: 'd',
      plan: ['p'],
      summary: 's',
      toolCalls: [],
      attribution: { cycleId: 'cyc-7' },
    });
    expect(store.loadMap().frontier[0].createdBy).toEqual({
      by: 'extractor',
      cycleId: 'cyc-7',
      at: NOW,
    });
  });

  it('the snapshot carries the direction history, newest first', () => {
    const store = svc.storeFor('b')!;
    for (let i = 0; i < 25; i++) store.appendDirection(record(i));
    const snap = svc.snapshot('b')!;
    expect(snap.directions).toHaveLength(20);
    expect(snap.directions[0].runId).toBe('r24');
  });

  it('signalFrontier and a 👎 on a frontier proposal record why it was dropped', () => {
    const store = svc.storeFor('b')!;
    store.saveMap({ ...emptyKnowledgeMap(), frontier: [fi('f1'), fi('f2')] });
    svc.signalFrontier('b', 'f1', 'down');
    expect(store.loadMap().frontier[0].droppedReason).toEqual({
      by: 'operator',
      at: NOW,
      via: 'frontier',
    });
    store.appendDispatch({
      id: 'd1',
      botId: 'b',
      createdAt: NOW,
      kind: 'proposal',
      topic: 't',
      hook: 'h',
      whyCare: 'w',
      evidence: 'e',
      action: 'a',
      body: 'b',
      editorScore: 0.9,
      status: 'sent',
      frontierId: 'f2',
    });
    svc.signalDispatch('b', 'd1', 'down');
    expect(store.loadMap().frontier[1].droppedReason).toEqual({
      by: 'operator',
      at: NOW,
      via: 'dispatch',
    });
  });
});

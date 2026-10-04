import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mergeExtraction } from '../../../src/bot/curiosity/knowledge-map';
import { CuriosityService } from '../../../src/bot/curiosity/service';
import type { Dispatch } from '../../../src/bot/curiosity/types';

const ROOT = join(import.meta.dir, '.tmp-curiosity-service');
const NOW = '2026-10-03T12:00:00.000Z';

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'd1',
  botId: 'bot',
  createdAt: NOW,
  kind: 'insight',
  topic: 'retrieval',
  hook: 'hook',
  whyCare: 'w',
  evidence: 'e',
  action: 'a',
  body: 'b',
  editorScore: 0.9,
  status: 'sent',
  sentAt: NOW,
  ...over,
});

describe('CuriosityService', () => {
  let svc: CuriosityService;

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    svc = new CuriosityService({
      getSoulDir: (id) => (id === 'ghost' ? null : join(ROOT, id)),
      getCuriosityInputs: (id) =>
        id === 'ghost'
          ? null
          : { global: undefined, bot: id === 'wild' ? { preset: 'wild' } : undefined },
      now: () => NOW,
    });
  });
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it('returns null for an unknown bot', () => {
    expect(svc.snapshot('ghost')).toBeNull();
    expect(svc.resolve('ghost')).toBeNull();
  });

  it('resolves per-bot config', () => {
    expect(svc.resolve('bot')?.preset).toBe('explorer');
    expect(svc.resolve('wild')?.preset).toBe('wild');
  });

  it('snapshot bundles config, map, navigator, taste, dispatches, frontier verdicts', () => {
    const store = svc.storeFor('bot')!;
    store.saveMap(
      mergeExtraction(
        store.loadMap(),
        {
          topic: 'retrieval',
          findings: [],
          surprises: [],
          openQuestions: [],
          frontier: [{ question: 'q?', whyInteresting: 'w', distance: 1, surpriseScore: 0.5 }],
          servedDirectiveIds: [],
          noSurprise: true,
        },
        NOW
      )
    );
    store.appendDispatch(dispatch());
    const snap = svc.snapshot('bot')!;
    expect(snap.botId).toBe('bot');
    expect(snap.config.preset).toBe('explorer');
    expect(snap.map.topics).toHaveLength(1);
    expect(snap.dispatches).toHaveLength(1);
    expect(snap.frontier[0].verdict.needsApproval).toEqual(['purpose']);
    expect(snap.concentration.window).toBe(0);
  });

  it('signalDispatch records the signal and teaches the taste model', () => {
    svc.storeFor('bot')!.appendDispatch(dispatch());
    const updated = svc.signalDispatch('bot', 'd1', 'up');
    expect(updated?.signal).toBe('up');
    expect(updated?.signalAt).toBe(NOW);
    expect(svc.storeFor('bot')!.loadTaste().topics.retrieval.up).toBe(1);
  });

  it('signalDispatch on a proposal approves or drops its frontier item', () => {
    const store = svc.storeFor('bot')!;
    const map = mergeExtraction(
      store.loadMap(),
      {
        topic: 't',
        findings: [],
        surprises: [],
        openQuestions: [],
        frontier: [
          { question: 'side quest?', whyInteresting: 'w', distance: 3, surpriseScore: 0.9 },
        ],
        servedDirectiveIds: [],
        noSurprise: false,
      },
      NOW
    );
    store.saveMap(map);
    const fid = map.frontier[0].id;
    store.appendDispatch(dispatch({ id: 'p1', kind: 'proposal', frontierId: fid }));
    svc.signalDispatch('bot', 'p1', 'more');
    expect(store.loadMap().frontier[0].operatorSignal).toBe('up');
    store.appendDispatch(dispatch({ id: 'p2', kind: 'proposal', frontierId: fid }));
    svc.signalDispatch('bot', 'p2', 'down');
    expect(store.loadMap().frontier[0].status).toBe('dropped');
  });

  it('signalDispatch returns null for an unknown dispatch', () => {
    expect(svc.signalDispatch('bot', 'nope', 'up')).toBeNull();
  });

  it('signalFrontier sets the operator verdict', () => {
    const store = svc.storeFor('bot')!;
    const map = mergeExtraction(
      store.loadMap(),
      {
        topic: 't',
        findings: [],
        surprises: [],
        openQuestions: [],
        frontier: [{ question: 'x?', whyInteresting: 'w', distance: 1, surpriseScore: 0.4 }],
        servedDirectiveIds: [],
        noSurprise: false,
      },
      NOW
    );
    store.saveMap(map);
    expect(svc.signalFrontier('bot', map.frontier[0].id, 'up')?.operatorSignal).toBe('up');
    expect(svc.signalFrontier('bot', 'nope', 'up')).toBeNull();
  });

  it('signalDirection needs a direction', () => {
    expect(svc.signalDirection('bot', 'up')).toBeNull();
    const store = svc.storeFor('bot')!;
    const nav = store.loadNavigator();
    nav.direction = { at: NOW, summary: 's', retrospective: 'r', bets: [] };
    store.saveNavigator(nav);
    expect(svc.signalDirection('bot', 'down')?.operatorSignal).toBe('down');
  });

  it('recordDirective adds an operator instruction to the navigator', () => {
    svc.recordDirective('bot', 'Look into retrieval', 'message');
    expect(svc.storeFor('bot')!.loadNavigator().directives[0].text).toBe('Look into retrieval');
  });
});

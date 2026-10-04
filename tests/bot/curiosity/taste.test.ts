import { describe, expect, it } from 'bun:test';
import { resolveCuriosity } from '../../../src/bot/curiosity/config';
import { emptyTasteProfile } from '../../../src/bot/curiosity/store';
import {
  IGNORED_AFTER_HOURS,
  applyIgnored,
  applySignal,
  likedTopicScores,
  renderTasteForPrompt,
} from '../../../src/bot/curiosity/taste';
import type { Dispatch } from '../../../src/bot/curiosity/types';

const settings = resolveCuriosity(undefined, undefined).dispatch; // base 12, min 4, max 168
const NOW = '2026-10-03T12:00:00.000Z';

const d = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'd1',
  botId: 'b',
  createdAt: '2026-10-01T00:00:00.000Z',
  kind: 'insight',
  topic: 'retrieval',
  hook: 'Reranking beats bigger embeddings',
  whyCare: 'w',
  evidence: 'e',
  action: 'a',
  body: 'b',
  editorScore: 0.8,
  status: 'sent',
  sentAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('applySignal', () => {
  it('up counts the topic and kind, remembers the hook, earns a shorter interval', () => {
    const t = applySignal(emptyTasteProfile(12), d(), 'up', settings, NOW);
    expect(t.topics.retrieval).toEqual({ up: 1, down: 0, more: 0 });
    expect(t.kinds.insight.up).toBe(1);
    expect(t.likedHooks).toEqual(['Reranking beats bigger embeddings']);
    expect(t.cadence.intervalHours).toBeCloseTo(9);
    expect(t.updatedAt).toBe(NOW);
  });

  it('more counts as a stronger like', () => {
    const t = applySignal(emptyTasteProfile(12), d(), 'more', settings, NOW);
    expect(t.topics.retrieval.more).toBe(1);
    expect(t.cadence.intervalHours).toBeCloseTo(9);
  });

  it('down remembers the hook as disliked and lengthens the interval', () => {
    const t = applySignal(emptyTasteProfile(12), d(), 'down', settings, NOW);
    expect(t.dislikedHooks).toEqual(['Reranking beats bigger embeddings']);
    expect(t.cadence.intervalHours).toBeCloseTo(15);
  });

  it('clamps the interval to the configured bounds', () => {
    let t = emptyTasteProfile(5);
    for (let i = 0; i < 10; i++) t = applySignal(t, d(), 'up', settings, NOW);
    expect(t.cadence.intervalHours).toBe(settings.minIntervalHours);
    t = emptyTasteProfile(160);
    t = applySignal(t, d(), 'down', settings, NOW);
    expect(t.cadence.intervalHours).toBe(settings.maxIntervalHours);
  });

  it('caps remembered hooks', () => {
    let t = emptyTasteProfile(12);
    for (let i = 0; i < 30; i++) t = applySignal(t, d({ hook: `h${i}` }), 'up', settings, NOW);
    expect(t.likedHooks.length).toBe(15);
    expect(t.likedHooks.at(-1)).toBe('h29');
  });
});

describe('applyIgnored', () => {
  it('lengthens the interval once per sent dispatch left unanswered', () => {
    const old = d({ sentAt: '2026-09-30T00:00:00.000Z' });
    const { taste, counted } = applyIgnored(emptyTasteProfile(12), [old], settings, NOW);
    expect(counted).toEqual(['d1']);
    expect(taste.cadence.intervalHours).toBeCloseTo(18);
  });

  it('ignores fresh, answered, held and already-counted dispatches', () => {
    const fresh = d({ id: 'a', sentAt: '2026-10-03T00:00:00.000Z' });
    const answered = d({ id: 'b', signal: 'up' });
    const held = d({ id: 'c', status: 'held' });
    const counted = d({ id: 'e', ignoredCounted: true });
    const r = applyIgnored(emptyTasteProfile(12), [fresh, answered, held, counted], settings, NOW);
    expect(r.counted).toEqual([]);
    expect(r.taste.cadence.intervalHours).toBe(12);
  });

  it('uses a 48h threshold', () => {
    expect(IGNORED_AFTER_HOURS).toBe(48);
  });
});

describe('likedTopicScores', () => {
  it('nets up + more − down per topic', () => {
    let t = emptyTasteProfile(12);
    t = applySignal(t, d(), 'up', settings, NOW);
    t = applySignal(t, d(), 'more', settings, NOW);
    t = applySignal(t, d({ topic: 'hype' }), 'down', settings, NOW);
    expect(likedTopicScores(t)).toEqual({ retrieval: 2, hype: -1 });
  });
});

describe('renderTasteForPrompt', () => {
  it('is empty with no signals', () => {
    expect(renderTasteForPrompt(emptyTasteProfile(12))).toBe('');
  });
  it('lists what lands and what does not', () => {
    let t = applySignal(emptyTasteProfile(12), d(), 'up', settings, NOW);
    t = applySignal(t, d({ topic: 'hype', hook: 'Ten tools you must try' }), 'down', settings, NOW);
    const text = renderTasteForPrompt(t);
    expect(text).toContain('What lands with the operator');
    expect(text).toContain('retrieval');
    expect(text).toContain('Reranking beats bigger embeddings');
    expect(text).toContain('Ten tools you must try');
  });
});

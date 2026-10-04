import { describe, expect, it } from 'bun:test';
import { CURIOSITY_PRESETS, resolveCuriosity } from '../../../src/bot/curiosity/config';
import {
  computeTopicConcentration,
  decideCycleMode,
  recordCycle,
  renderFrontierForPrompt,
  selectFrontierItem,
} from '../../../src/bot/curiosity/cycle';
import { emptyKnowledgeMap } from '../../../src/bot/curiosity/knowledge-map';
import { emptyNavigatorState } from '../../../src/bot/curiosity/store';
import type {
  CycleTopicEntry,
  FrontierItem,
  KnowledgeMap,
} from '../../../src/bot/curiosity/types';

const entry = (topic: string, over: Partial<CycleTopicEntry> = {}): CycleTopicEntry => ({
  at: '2026-10-03T00:00:00Z',
  topic,
  mode: 'exploit',
  surprised: true,
  ...over,
});

const fi = (id: string, over: Partial<FrontierItem> = {}): FrontierItem => ({
  id,
  question: `q-${id}`,
  whyInteresting: 'w',
  bridge: 'b',
  distance: 1,
  surpriseScore: 0.5,
  createdAt: '2026-10-01T00:00:00Z',
  status: 'open',
  ...over,
});

const mapWith = (frontier: FrontierItem[]): KnowledgeMap => ({ ...emptyKnowledgeMap(), frontier });

describe('computeTopicConcentration', () => {
  it('returns zero share for an empty log', () => {
    expect(computeTopicConcentration([], 8)).toEqual({
      dominantTopic: null,
      share: 0,
      count: 0,
      window: 0,
    });
  });

  it('measures the dominant topic within the window only', () => {
    const log = [entry('a'), entry('a'), entry('a'), entry('b'), entry('a'), entry('c')];
    const c = computeTopicConcentration(log, 4);
    expect(c.window).toBe(4);
    expect(c.dominantTopic).toBe('a');
    expect(c.share).toBeCloseTo(0.5);
  });
});

describe('decideCycleMode', () => {
  const cfg = resolveCuriosity(undefined, { exploreRatio: 0.25, maxTopicShare: 0.6 });

  it('exploits when curiosity is disabled', () => {
    const off = { ...cfg, enabled: false };
    expect(decideCycleMode(emptyNavigatorState(), off).mode).toBe('exploit');
  });

  it('explores when one topic dominates a full-enough window', () => {
    const nav = {
      ...emptyNavigatorState(),
      cyclesSinceExplore: 1,
      cycleLog: Array.from({ length: 8 }, () => entry('harness')),
    };
    const d = decideCycleMode(nav, cfg);
    expect(d.mode).toBe('explore');
    expect(d.reason).toBe('concentration');
  });

  it('does not fire concentration on a short log', () => {
    const nav = { ...emptyNavigatorState(), cycleLog: [entry('a'), entry('a')] };
    expect(decideCycleMode(nav, cfg).reason).not.toBe('concentration');
  });

  it('explores after a no-surprise streak', () => {
    const nav = {
      ...emptyNavigatorState(),
      cyclesSinceExplore: 1,
      noSurpriseStreak: cfg.noSurpriseStreak,
    };
    expect(decideCycleMode(nav, cfg)).toEqual({ mode: 'explore', reason: 'no-surprise' });
  });

  it('explores on budget every 1/ratio cycles', () => {
    const nav = { ...emptyNavigatorState(), cyclesSinceExplore: 3 };
    expect(decideCycleMode(nav, cfg)).toEqual({ mode: 'explore', reason: 'budget' });
    expect(decideCycleMode({ ...nav, cyclesSinceExplore: 2 }, cfg).mode).toBe('exploit');
  });

  it('never explores on budget with ratio 0', () => {
    const zero = { ...cfg, exploreRatio: 0 };
    const nav = { ...emptyNavigatorState(), cyclesSinceExplore: 100 };
    expect(decideCycleMode(nav, zero).mode).toBe('exploit');
  });

  it('a silent operator doubles the explore cadence instead of idling the bot', () => {
    const nav = { ...emptyNavigatorState(), cyclesSinceExplore: 1 };
    expect(decideCycleMode(nav, cfg)).toEqual({ mode: 'exploit', reason: 'default' });
    expect(decideCycleMode(nav, cfg, { operatorSilent: true })).toEqual({
      mode: 'explore',
      reason: 'operator-silent',
    });
  });
});

describe('recordCycle', () => {
  it('appends, resets the explore counter on explore, tracks the surprise streak', () => {
    let nav = emptyNavigatorState();
    nav = recordCycle(nav, entry('a', { surprised: false }));
    nav = recordCycle(nav, entry('a', { surprised: false }));
    expect(nav.cyclesSinceExplore).toBe(2);
    expect(nav.noSurpriseStreak).toBe(2);
    nav = recordCycle(nav, entry('b', { mode: 'explore', surprised: true }));
    expect(nav.cyclesSinceExplore).toBe(0);
    expect(nav.noSurpriseStreak).toBe(0);
    expect(nav.cycleLog).toHaveLength(3);
  });

  it('caps the log', () => {
    let nav = emptyNavigatorState();
    for (let i = 0; i < 40; i++) nav = recordCycle(nav, entry(`t${i}`), 30);
    expect(nav.cycleLog).toHaveLength(30);
    expect(nav.cycleLog.at(-1)?.topic).toBe('t39');
  });
});

describe('selectFrontierItem', () => {
  const explorer = CURIOSITY_PRESETS.explorer;

  it('returns null with an empty frontier', () => {
    expect(selectFrontierItem(emptyKnowledgeMap(), explorer).item).toBeNull();
  });

  it('picks the highest-surprise allowed open item', () => {
    const map = mapWith([
      fi('a', { surpriseScore: 0.4 }),
      fi('b', { surpriseScore: 0.9 }),
      fi('c', { surpriseScore: 0.99, status: 'explored' }),
    ]);
    expect(selectFrontierItem(map, explorer).item?.id).toBe('b');
  });

  it('skips items the dials block and surfaces ask-gated ones as proposals', () => {
    const map = mapWith([
      fi('far', { distance: 3, surpriseScore: 0.95 }),
      fi('nobridge', { bridge: undefined, surpriseScore: 0.9 }),
      fi('ok', { surpriseScore: 0.3 }),
    ]);
    const focused = selectFrontierItem(map, CURIOSITY_PRESETS.focused);
    expect(focused.item?.id).toBe('ok');
    const explorerPick = selectFrontierItem(map, explorer);
    expect(explorerPick.item?.id).toBe('far');
    expect(explorerPick.proposals.map((p) => p.item.id)).toEqual(['nobridge']);
    expect(explorerPick.proposals[0].crossing).toEqual(['purpose']);
  });

  it('prefers items away from the dominant topic', () => {
    const map = mapWith([
      fi('same', { surpriseScore: 0.6, fromTopic: 'harness' }),
      fi('other', { surpriseScore: 0.55, fromTopic: 'retrieval' }),
    ]);
    expect(selectFrontierItem(map, explorer, { avoidTopic: 'harness' }).item?.id).toBe('other');
  });

  it('boosts operator-approved items and liked topics', () => {
    const map = mapWith([
      fi('plain', { surpriseScore: 0.7 }),
      fi('liked', { surpriseScore: 0.5, fromTopic: 'economics' }),
    ]);
    const pick = selectFrontierItem(map, explorer, {
      likedTopics: { economics: 3 },
    });
    expect(pick.item?.id).toBe('liked');
  });
});

describe('renderFrontierForPrompt', () => {
  it('lists open items with crossing tags', () => {
    const map = mapWith([fi('a'), fi('b', { bridge: undefined, distance: 2 })]);
    const text = renderFrontierForPrompt(map, CURIOSITY_PRESETS.explorer);
    expect(text).toContain('[a]');
    expect(text).toContain('needs operator OK: purpose');
  });

  it('is empty-safe', () => {
    expect(renderFrontierForPrompt(emptyKnowledgeMap(), CURIOSITY_PRESETS.explorer)).toContain(
      'empty'
    );
  });
});

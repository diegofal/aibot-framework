import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyKnowledgeMap } from '../../../src/bot/curiosity/knowledge-map';
import { CURIOSITY_FILES, CuriosityStore } from '../../../src/bot/curiosity/store';
import type { Dispatch } from '../../../src/bot/curiosity/types';

const DIR = join(import.meta.dir, '.tmp-curiosity-store');

const dispatch = (id: string, over: Partial<Dispatch> = {}): Dispatch => ({
  id,
  botId: 'b',
  createdAt: `2026-10-0${id.length}T00:00:00Z`,
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
});

describe('CuriosityStore', () => {
  let store: CuriosityStore;
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    store = new CuriosityStore(DIR);
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it('returns empty defaults when nothing is on disk', () => {
    expect(store.loadMap()).toEqual(emptyKnowledgeMap());
    const nav = store.loadNavigator();
    expect(nav.directives).toEqual([]);
    expect(nav.lastNavigatorAt).toBeNull();
    const taste = store.loadTaste();
    expect(taste.cadence.lastSentAt).toBeNull();
    expect(store.listDispatches()).toEqual([]);
  });

  it('round-trips the knowledge map', () => {
    const map = emptyKnowledgeMap();
    map.interests.push('x');
    store.saveMap(map);
    expect(existsSync(join(DIR, CURIOSITY_FILES.knowledge))).toBe(true);
    expect(store.loadMap().interests).toEqual(['x']);
  });

  it('round-trips navigator state and taste', () => {
    const nav = store.loadNavigator();
    nav.cyclesSinceExplore = 4;
    store.saveNavigator(nav);
    expect(store.loadNavigator().cyclesSinceExplore).toBe(4);
    const taste = store.loadTaste();
    taste.likedHooks.push('wow');
    store.saveTaste(taste);
    expect(store.loadTaste().likedHooks).toEqual(['wow']);
  });

  it('falls back to defaults on corrupt JSON instead of throwing', () => {
    writeFileSync(join(DIR, CURIOSITY_FILES.knowledge), '{not json');
    expect(store.loadMap()).toEqual(emptyKnowledgeMap());
  });

  it('fills missing keys from defaults for older files', () => {
    writeFileSync(join(DIR, CURIOSITY_FILES.navigator), JSON.stringify({ version: 1 }));
    const nav = store.loadNavigator();
    expect(nav.cycleLog).toEqual([]);
    expect(nav.noSurpriseStreak).toBe(0);
  });

  it('appends and lists dispatches newest first, with a limit', () => {
    store.appendDispatch(dispatch('a'));
    store.appendDispatch(dispatch('bb'));
    store.appendDispatch(dispatch('ccc'));
    expect(store.listDispatches().map((d) => d.id)).toEqual(['ccc', 'bb', 'a']);
    expect(store.listDispatches(2).map((d) => d.id)).toEqual(['ccc', 'bb']);
  });

  it('skips malformed dispatch lines', () => {
    store.appendDispatch(dispatch('a'));
    writeFileSync(
      join(DIR, CURIOSITY_FILES.dispatches),
      `${readFileSync(join(DIR, CURIOSITY_FILES.dispatches), 'utf-8')}garbage\n`
    );
    expect(store.listDispatches()).toHaveLength(1);
  });

  it('updates a dispatch in place', () => {
    store.appendDispatch(dispatch('a'));
    store.appendDispatch(dispatch('bb'));
    const updated = store.updateDispatch('a', { signal: 'up', signalAt: 'now' });
    expect(updated?.signal).toBe('up');
    expect(store.getDispatch('a')?.signal).toBe('up');
    expect(store.getDispatch('bb')?.signal).toBeUndefined();
  });

  it('updateDispatch returns null for an unknown id', () => {
    expect(store.updateDispatch('zzz', { signal: 'up' })).toBeNull();
  });

  it('creates the soul dir if missing', () => {
    const nested = new CuriosityStore(join(DIR, 'deep', 'soul'));
    nested.saveMap(emptyKnowledgeMap());
    expect(existsSync(join(DIR, 'deep', 'soul', CURIOSITY_FILES.knowledge))).toBe(true);
  });
});

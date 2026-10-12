import { describe, expect, it } from 'bun:test';
import { digestSources, inferOrigin, triggerOfDispatch } from '../../../src/bot/curiosity/origin';
import type { Dispatch } from '../../../src/bot/curiosity/types';

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'd1',
  botId: 'bot',
  createdAt: '2026-10-11T12:58:20.000Z',
  kind: 'insight',
  topic: 't',
  hook: 'hook',
  whyCare: 'w',
  evidence: 'e',
  action: 'a',
  body: 'b',
  editorScore: 0.5,
  status: 'held',
  ...over,
});

const cycle = (over: Record<string, unknown> = {}) => ({
  cycleId: 'c1',
  startedAt: '2026-10-11T12:57:14.000Z',
  endedAt: '2026-10-11T12:58:36.000Z',
  planSummary: 'Search FDE roles',
  goalId: 'g-1',
  goalTitle: 'Find remote roles',
  ...over,
});

describe('triggerOfDispatch', () => {
  it('reads the trigger from the kind, an interest or a frontier item', () => {
    expect(triggerOfDispatch(dispatch())).toBe('insight');
    expect(triggerOfDispatch(dispatch({ kind: 'digest' }))).toBe('digest');
    expect(triggerOfDispatch(dispatch({ kind: 'proposal', interest: 'x' }))).toBe('interest');
    expect(triggerOfDispatch(dispatch({ kind: 'proposal', frontierId: 'f' }))).toBe('frontier');
  });
});

describe('inferOrigin', () => {
  it('keeps a recorded origin as is', () => {
    const origin = { trigger: 'insight' as const, cycleId: 'real' };
    expect(inferOrigin(dispatch({ origin }), [cycle()])).toBe(origin);
  });

  it('matches the cycle whose run contains the dispatch, marked inferred', () => {
    expect(
      inferOrigin(dispatch(), [
        cycle({ cycleId: 'other', endedAt: '2026-10-11T12:57:00Z' }),
        cycle(),
      ])
    ).toEqual({
      trigger: 'insight',
      cycleId: 'c1',
      goalId: 'g-1',
      goalTitle: 'Find remote roles',
      plan: 'Search FDE roles',
      inferred: true,
    });
  });

  it('leaves out a goal the cycle did not serve', () => {
    const o = inferOrigin(dispatch(), [cycle({ goalId: null, goalTitle: null })]);
    expect(o?.goalId).toBeUndefined();
    expect(o?.goalTitle).toBeUndefined();
  });

  it('returns undefined when no cycle contains it (written before cycles were logged)', () => {
    expect(inferOrigin(dispatch(), [])).toBeUndefined();
    expect(inferOrigin(dispatch(), [cycle({ endedAt: undefined })])).toBeUndefined();
  });
});

describe('digestSources', () => {
  const held1 = dispatch({
    id: 'h1',
    hook: 'One',
    createdAt: '2026-10-05T10:00:00Z',
    editorScore: 0.4,
  });
  const held2 = dispatch({
    id: 'h2',
    hook: 'Two',
    createdAt: '2026-10-06T10:00:00Z',
    editorScore: 0.6,
  });

  it('resolves recorded source ids, in order, skipping unknown ones', () => {
    const digest = dispatch({
      kind: 'digest',
      origin: { trigger: 'digest', sourceIds: ['h2', 'gone', 'h1'] },
    });
    expect(digestSources(digest, [held1, held2, digest])).toEqual({
      inferred: false,
      items: [
        { id: 'h2', hook: 'Two', createdAt: held2.createdAt, editorScore: 0.6 },
        { id: 'h1', hook: 'One', createdAt: held1.createdAt, editorScore: 0.4 },
      ],
    });
  });

  it('without recorded ids: the strongest earlier findings since the last sent digest', () => {
    const sentDigest = dispatch({
      id: 'sd',
      kind: 'digest',
      status: 'sent',
      createdAt: '2026-10-05T12:00:00Z',
    });
    const later = dispatch({ id: 'later', createdAt: '2026-10-12T00:00:00Z' });
    const digest = dispatch({ id: 'dg', kind: 'digest' });
    const r = digestSources(digest, [held1, sentDigest, held2, later, digest]);
    expect(r?.inferred).toBe(true);
    expect(r?.items.map((i) => i.id)).toEqual(['h2']);
  });

  it('is undefined for anything that is not a digest', () => {
    expect(digestSources(dispatch(), [held1])).toBeUndefined();
  });
});

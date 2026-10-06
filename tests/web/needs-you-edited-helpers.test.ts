/**
 * Needs You — outputs the bot edited after a human approved/rejected them.
 * They stay listed (under their own group, with the earlier verdict) but are
 * not counted as new review work.
 */
import { describe, expect, it } from 'bun:test';
import {
  decisionCount,
  detailPanel,
  groupItems,
  initialState,
  isEditedSinceReview,
  kindCounts,
  listRow,
  visibleItems,
} from '../../web/pages/needs-you-helpers.js';

const NOW = Date.UTC(2026, 9, 6, 12);
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function prod(id: string, ageH: number, meta: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'production',
    botId: 'b1',
    botName: 'Bot One',
    title: `${id}.md`,
    body: '',
    options: null,
    createdAt: iso(NOW - ageH * H),
    urgency: 'low',
    actions: [],
    href: '#/work/productions/b1',
    meta: { size: 77, editedSinceReview: false, ...meta },
  };
}

const edited = prod('e1', 2, {
  editedSinceReview: true,
  priorStatus: 'rejected',
  priorReviewedAt: iso(NOW - 30 * H),
  priorSize: 1324,
});
const fresh = prod('n1', 3);

describe('isEditedSinceReview', () => {
  it('is true only for production items flagged by the server', () => {
    expect(isEditedSinceReview(edited)).toBe(true);
    expect(isEditedSinceReview(fresh)).toBe(false);
    expect(isEditedSinceReview({ ...edited, kind: 'ask' })).toBe(false);
    expect(isEditedSinceReview(null)).toBe(false);
  });
});

describe('groupItems — edited group', () => {
  it('puts edited outputs in their own last group regardless of age', () => {
    const groups = groupItems([edited, fresh], NOW);
    expect(groups.map((g) => g.id)).toEqual(['today', 'edited']);
    expect(groups[1].label).toBe('Edited since your review');
    expect(groups[1].items.map((i) => i.id)).toEqual(['e1']);
  });

  it('visibleItems keeps that order so j/k walk the edited group last', () => {
    const state = initialState([edited, fresh], null, { nowMs: NOW });
    expect(visibleItems(state).map((i) => i.id)).toEqual(['n1', 'e1']);
  });
});

describe('counts exclude edited outputs', () => {
  it('decisionCount skips them', () => {
    expect(decisionCount([edited, fresh])).toBe(1);
    expect(decisionCount([])).toBe(0);
  });

  it('kindCounts reports them apart', () => {
    const counts = kindCounts(initialState([edited, fresh], null, { nowMs: NOW }));
    expect(counts.all).toBe(1);
    expect(counts.production).toBe(1);
    expect(counts.edited).toBe(1);
  });
});

describe('edited rendering', () => {
  it('the row carries an "edited · was rejected" badge', () => {
    expect(listRow(edited, false, NOW)).toContain('edited · was rejected');
    expect(listRow(fresh, false, NOW)).not.toContain('edited ·');
  });

  it('the detail says what the human decided and how the file changed since', () => {
    const html = detailPanel(edited, {}, NOW);
    expect(html).toContain('You rejected this');
    expect(html).toContain('1324 → 77 bytes');
    expect(detailPanel(fresh, {}, NOW)).not.toContain('You rejected');
  });
});

import { describe, expect, it } from 'bun:test';
import { cycleStrip, diversitySeries, landingSegments } from '../../web/pages/stats-helpers.js';

// Field names pinned against `CuriosityStatsResponse` in src/stats/types.ts.

describe('landingSegments', () => {
  it('returns one segment per non-zero outcome, in fixed order, as a share of sent', () => {
    const segs = landingSegments({ sent: 4, up: 2, more: 0, down: 1, ignored: 0, pending: 1 });
    expect(segs).toEqual([
      { key: 'up', label: '👍', count: 2, pct: 50 },
      { key: 'down', label: '👎', count: 1, pct: 25 },
      { key: 'pending', label: 'open', count: 1, pct: 25 },
    ]);
  });

  it('nothing sent → no segments', () => {
    expect(landingSegments({ sent: 0 })).toEqual([]);
    expect(landingSegments(null)).toEqual([]);
  });
});

describe('diversitySeries', () => {
  it('splits points into the two sparkline series', () => {
    expect(
      diversitySeries([
        { distinctTopics: 1, dominantShare: 1 },
        { distinctTopics: 2, dominantShare: 0.5 },
      ])
    ).toEqual({ distinct: [1, 2], share: [1, 0.5] });
  });

  it('tolerates missing or non-numeric values', () => {
    expect(diversitySeries([{}, { distinctTopics: 'x' }])).toEqual({
      distinct: [0, 0],
      share: [0, 0],
    });
    expect(diversitySeries(undefined)).toEqual({ distinct: [], share: [] });
  });
});

describe('cycleStrip', () => {
  it('one cell per cycle: mode class, surprise class, escaped title', () => {
    const cells = cycleStrip([
      { at: '2026-10-04T00:00:00.000Z', topic: 'a<b', mode: 'explore', surprised: true },
      { at: '2026-10-04T12:00:00.000Z', topic: 'c', mode: 'exploit', surprised: false },
    ]);
    expect(cells).toHaveLength(2);
    expect(cells[0].cls).toBe('cur-cell cur-explore cur-surprised');
    expect(cells[0].title).toContain('a&lt;b');
    expect(cells[0].title).toContain('explore');
    expect(cells[1].cls).toBe('cur-cell cur-exploit');
  });
});

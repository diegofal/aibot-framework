import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readFeedbackLastAt,
  readGoals,
  readSoulHealth,
  readTraits,
} from '../../../src/stats/readers/soul';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

let soulDir: string;
beforeEach(() => {
  soulDir = createTempDir('stats-soul');
});
afterEach(() => removeTempDir(soulDir));

const GOALS = `# Goals

## Active Goals

- [ ] **Write weekly digest**
  - status: in_progress
  - priority: high
  - notes: ${'n'.repeat(400)}
- [ ] Write weekly digest
  - status: blocked
- [ ] Old thing
  - status: archived
- [ ] Another
  - source: strategist

## Completed

- [x] Ship v1
  - completed: 2026-08-01
  - outcome: done
- [x] Ship v2
  - completed: 2026-08-10
`;

describe('readGoals', () => {
  it('zeros for a missing GOALS.md', () => {
    const g = readGoals(soulDir);
    expect(g.stats).toEqual({
      active: 0,
      completed: 0,
      byStatus: {},
      archivedInActive: 0,
      duplicates: 0,
      oversizedNotes: 0,
      lastCompletedAt: null,
    });
    expect(g.detail).toEqual([]);
  });
  it('aggregates statuses, duplicates, archived-in-active, oversized notes and last completion', () => {
    writeFileSync(join(soulDir, 'GOALS.md'), GOALS);
    const g = readGoals(soulDir);
    expect(g.stats.active).toBe(4);
    expect(g.stats.completed).toBe(2);
    expect(g.stats.byStatus).toEqual({ in_progress: 1, blocked: 1, archived: 1, pending: 1 });
    expect(g.stats.archivedInActive).toBe(1);
    expect(g.stats.duplicates).toBe(1);
    expect(g.stats.oversizedNotes).toBe(1);
    expect(g.stats.lastCompletedAt).toBe('2026-08-10');
    expect(g.detail).toHaveLength(6);
    expect(g.detail[0]).toEqual({
      text: '**Write weekly digest**',
      status: 'in_progress',
      priority: 'high',
      notes: 'n'.repeat(400),
      notesLength: 400,
      completed: null,
      outcome: null,
      source: null,
      section: 'active',
    });
    expect(g.detail[4].section).toBe('completed');
  });

  it('sends the actual notes text, not just its length — the stats page renders a preview from it', () => {
    writeFileSync(join(soulDir, 'GOALS.md'), GOALS);
    const g = readGoals(soulDir);
    expect(g.detail[0].notes).toBe('n'.repeat(400));
    // A goal with no notes gets null, not an empty string or undefined —
    // the frontend's `g.notes ? … : ''` check depends on that.
    expect(g.detail[1].notes).toBeNull();
  });
});

describe('readTraits', () => {
  it('nulls when TRAITS.json is missing', () => {
    expect(readTraits(soulDir)).toEqual({
      stats: { current: null, baseline: null, drift: null, adjustments: 0 },
      history: [],
    });
  });
  it('uses the first history snapshot as baseline and computes drift', () => {
    const t0 = { curiosity: 0.5, caution: 0.5 };
    const t1 = { curiosity: 0.7, caution: 0.4 };
    writeFileSync(
      join(soulDir, 'TRAITS.json'),
      JSON.stringify({
        current: t1,
        history: [
          { timestamp: 1, source: 'strategist', traits: t0 },
          { timestamp: 2, source: 'adaptive', traits: t1 },
        ],
      })
    );
    const r = readTraits(soulDir);
    expect(r.stats.current).toEqual(t1);
    expect(r.stats.baseline).toEqual(t0);
    expect(r.stats.drift).toEqual({ curiosity: 0.2, caution: -0.1 });
    expect(r.stats.adjustments).toBe(2);
    expect(r.history).toHaveLength(2);
  });
  it('falls back to the 0.5 default baseline when history is empty', () => {
    writeFileSync(
      join(soulDir, 'TRAITS.json'),
      JSON.stringify({ current: { curiosity: 0.9 }, history: [] })
    );
    const r = readTraits(soulDir);
    expect(r.stats.baseline?.curiosity).toBe(0.5);
    expect(r.stats.drift?.curiosity).toBe(0.4);
    expect(r.stats.adjustments).toBe(0);
  });
});

describe('readSoulHealth', () => {
  it('reports every core file missing on an empty dir', () => {
    const h = readSoulHealth(soulDir);
    expect(h.missingFiles).toEqual([
      'SOUL.md',
      'IDENTITY.md',
      'GOALS.md',
      'MEMORY.md',
      'MOTIVATIONS.md',
    ]);
    expect(h.lastReflectionAt).toBeNull();
    expect(h.lastHealthCheckAt).toBeNull();
    expect(h.memoryBytes).toBe(0);
    expect(h.dailyLogsPending).toBe(0);
    expect(h.soulEqualsMotivations).toBe(false);
  });
  it('reads sizes, reflection watermark, health-check cooldown, daily logs and soul==motivations', () => {
    writeFileSync(join(soulDir, 'SOUL.md'), 'same\n');
    writeFileSync(join(soulDir, 'MOTIVATIONS.md'), 'same\n');
    writeFileSync(join(soulDir, 'MEMORY.md'), '12345678');
    writeFileSync(join(soulDir, 'GOALS.md'), '## Active Goals\n');
    writeFileSync(join(soulDir, '.last-health-check'), String(Date.UTC(2026, 7, 20)));
    mkdirSync(join(soulDir, 'memory'));
    writeFileSync(join(soulDir, 'memory', '2000-01-01.md'), 'old');
    writeFileSync(join(soulDir, 'memory', '2000-01-02.md'), 'old');
    const h = readSoulHealth(soulDir);
    expect(h.missingFiles).toEqual(['IDENTITY.md']);
    expect(h.memoryBytes).toBe(8);
    expect(h.goalsBytes).toBe(16);
    expect(h.lastHealthCheckAt).toBe('2026-08-20T00:00:00.000Z');
    expect(h.dailyLogsPending).toBe(2);
    expect(h.soulEqualsMotivations).toBe(true);
  });
  it('takes the latest reflection date from MOTIVATIONS.md', () => {
    writeFileSync(
      join(soulDir, 'MOTIVATIONS.md'),
      '## Reflection log\n- date: 2026-07-01\n  - trigger: x\n- date: 2026-08-15\n'
    );
    writeFileSync(join(soulDir, 'SOUL.md'), 'different');
    const h = readSoulHealth(soulDir);
    expect(h.lastReflectionAt).toBe('2026-08-15');
    expect(h.soulEqualsMotivations).toBe(false);
  });
});

describe('readFeedbackLastAt', () => {
  it('null when missing, otherwise the latest createdAt', () => {
    expect(readFeedbackLastAt(soulDir)).toBeNull();
    writeFileSync(
      join(soulDir, 'feedback.jsonl'),
      `${JSON.stringify({ id: 'a', createdAt: '2026-08-01T00:00:00.000Z' })}\n${JSON.stringify({ id: 'b', createdAt: '2026-08-05T00:00:00.000Z' })}\n`
    );
    expect(readFeedbackLastAt(soulDir)).toBe(Date.parse('2026-08-05T00:00:00.000Z'));
  });
});

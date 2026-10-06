/**
 * pendingFiles — the one definition of "unreviewed" shared by Needs You,
 * Stats, Agent Home, Fleet Home and productions-triage.
 *
 * A file is pending when it is active (not archived / deleted, not a
 * bookkeeping path) and its latest content row has no verdict. When an
 * earlier row of the same file had a verdict, the file is "edited since
 * review" and carries that verdict as `priorVerdict`.
 */

import { describe, expect, test } from 'bun:test';
import { pendingFiles } from '../../src/productions/changelog';
import type { ProductionEntry } from '../../src/productions/types';

let seq = 0;
function row(overrides: Partial<ProductionEntry>): ProductionEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    timestamp: '2026-10-01T00:00:00.000Z',
    botId: 'b1',
    tool: 'file_write',
    path: 'a.md',
    action: 'create',
    description: '',
    size: 100,
    trackOnly: false,
    ...overrides,
  };
}

const T = (day: number, hour = 0) =>
  new Date(Date.UTC(2026, 9, day, hour)).toISOString();

describe('pendingFiles', () => {
  test('a never-reviewed file is pending with no prior verdict, pending since its first row', () => {
    const rows = [
      row({ id: 'c', path: 'a.md', timestamp: T(1) }),
      row({ id: 'e', path: 'a.md', action: 'edit', timestamp: T(2), size: 120 }),
    ];
    const [p, ...rest] = pendingFiles(rows);
    expect(rest).toHaveLength(0);
    expect(p.entry.id).toBe('e');
    expect(p.key).toBe('a.md');
    expect(p.priorVerdict).toBeNull();
    expect(p.pendingSince).toBe(T(1));
  });

  test('a file whose latest row has a verdict is not pending', () => {
    const rows = [
      row({ path: 'a.md', timestamp: T(1) }),
      row({
        path: 'a.md',
        action: 'edit',
        timestamp: T(2),
        evaluation: { status: 'approved', evaluatedAt: T(3) },
      }),
    ];
    expect(pendingFiles(rows)).toEqual([]);
  });

  test('an edit after a verdict is "edited since review" carrying the earlier verdict', () => {
    const rows = [
      row({
        id: 'r1',
        path: 'a.md',
        timestamp: T(1),
        size: 1324,
        evaluation: { status: 'rejected', evaluatedAt: T(2) },
      }),
      row({ id: 'r2', path: 'a.md', action: 'edit', timestamp: T(3), size: 43 }),
      row({ id: 'r3', path: 'a.md', action: 'edit', timestamp: T(4), size: 77 }),
    ];
    const [p] = pendingFiles(rows);
    expect(p.entry.id).toBe('r3');
    expect(p.priorVerdict).toEqual({ status: 'rejected', at: T(2), entryId: 'r1', size: 1324 });
    // Staleness starts at the first edit after the verdict, not the latest one.
    expect(p.pendingSince).toBe(T(3));
  });

  test('the verdict time falls back to the row timestamp when evaluatedAt is missing', () => {
    const rows = [
      row({ id: 'r1', timestamp: T(1), evaluation: { status: 'approved' } as never }),
      row({ id: 'r2', action: 'edit', timestamp: T(2) }),
    ];
    expect(pendingFiles(rows)[0].priorVerdict?.at).toBe(T(1));
  });

  test('a bot comment without a status (coherence check) is not a verdict', () => {
    const rows = [
      row({
        id: 'r1',
        timestamp: T(1),
        evaluation: { evaluatedAt: T(2), aiResponse: 'Coherence Check (OK)' },
      }),
    ];
    const [p] = pendingFiles(rows);
    expect(p.entry.id).toBe('r1');
    expect(p.priorVerdict).toBeNull();
  });

  test('archive and delete remove the file; a later re-create starts fresh', () => {
    const rows = [
      row({ path: 'a.md', timestamp: T(1), evaluation: { status: 'approved', evaluatedAt: T(1) } }),
      row({
        path: 'archived/a.md',
        action: 'archive',
        tool: 'archive',
        archivedFrom: 'a.md',
        timestamp: T(2),
      }),
      row({ id: 'again', path: 'a.md', timestamp: T(3) }),
      row({ path: 'b.md', timestamp: T(1) }),
      row({ path: 'b.md', action: 'delete', timestamp: T(2) }),
    ];
    const pending = pendingFiles(rows);
    expect(pending.map((p) => p.entry.id)).toEqual(['again']);
    expect(pending[0].priorVerdict).toBeNull();
  });

  test('bookkeeping and archived paths are never pending', () => {
    const rows = [
      row({ path: 'changelog.jsonl', timestamp: T(1) }),
      row({ path: 'summary.json', timestamp: T(1) }),
      row({ path: 'archived/22_paraphrase_proxy.ts', action: 'edit', timestamp: T(2) }),
      row({ id: 'real', path: '01_ideas.md', timestamp: T(1) }),
    ];
    expect(pendingFiles(rows).map((p) => p.entry.id)).toEqual(['real']);
  });

  test('normalize folds absolute and relative forms of the same file together', () => {
    const rows = [
      row({ id: 'abs', path: '/app/productions/b1/a.md', timestamp: T(1) }),
      row({
        path: 'archived/a.md',
        action: 'archive',
        tool: 'archive',
        archivedFrom: 'a.md',
        timestamp: T(2),
      }),
    ];
    const normalize = (p: string) => p.replace('/app/productions/b1/', '');
    expect(pendingFiles(rows, normalize)).toEqual([]);
  });

  test('rows are replayed in time order regardless of file order; malformed rows are skipped', () => {
    const rows = [
      row({ id: 'late', path: 'a.md', action: 'edit', timestamp: T(5) }),
      row({ path: 'a.md', timestamp: T(1), evaluation: { status: 'approved', evaluatedAt: T(2) } }),
      { nope: true } as unknown as ProductionEntry,
    ];
    const [p] = pendingFiles(rows);
    expect(p.entry.id).toBe('late');
    expect(p.priorVerdict?.status).toBe('approved');
  });
});

/**
 * Cycle 6 — changelog.ts Red tests.
 *
 * Pinning the contract of src/productions/changelog.ts. Per
 * docs/architecture-docs/productions-refactor.md §4 C4 + §6, this
 * module extracts the JSONL read/write logic and the pure reduction
 * functions from ProductionsService.
 *
 * Module boundary:
 *   - Pure functions: parseEntries, filterEntries, sortByTimestamp,
 *     filterApproved, filterRejected, getStatsFromEntries,
 *     serializeEntries, mergeEntries (findId + update).
 *   - I/O functions: readEntries(changelogPath), writeEntries(path, entries),
 *     appendEntry(path, entry).
 *   - I/O functions are thin wrappers around node:fs; they exist so
 *     service.ts does not need to import fs directly.
 *
 * Per-function coverage: each function gets its own describe block
 * with branch tests (per CLAUDE.md §"Flujo TDD obligatorio").
 *
 * Cycle 6.1 writes these tests (Red). Cycle 6.3 creates the module
 * (Green). Cycle 6.4 makes the C4 contract test turn green by
 * delegating from service.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  append,
  appendEntry,
  filterApproved,
  filterEntries,
  filterRejected,
  getStatsFromEntries,
  loadAllEntries,
  loadChangelog,
  loadEntry,
  loadStats,
  parseEntries,
  readEntries,
  removeEntriesByPath,
  serializeEntries,
  sortByTimestamp,
  updateEntry,
  writeEntries,
} from '../../src/productions/changelog';
import type { ProductionEntry } from '../../src/productions/types';

const TEMP_DIR = join(process.cwd(), '.test-productions-changelog');

beforeEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

function entry(overrides: Partial<ProductionEntry>): ProductionEntry {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    timestamp: '2025-01-01T00:00:00.000Z',
    botId: 'bot1',
    tool: 'file_write',
    path: 'a.md',
    action: 'create',
    description: '',
    size: 0,
    trackOnly: false,
    ...overrides,
  } as ProductionEntry;
}

// ---------------------------------------------------------------------------
// parseEntries
// ---------------------------------------------------------------------------

describe('parseEntries', () => {
  test('parses valid JSONL lines into entries', () => {
    const lines = [
      JSON.stringify({ id: '1', timestamp: '2025-01-01', botId: 'b', tool: 'x', path: 'p', action: 'a', description: '', size: 0, trackOnly: false }),
      JSON.stringify({ id: '2', timestamp: '2025-01-02', botId: 'b', tool: 'x', path: 'p', action: 'a', description: '', size: 0, trackOnly: false }),
    ];
    const entries = parseEntries(lines);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('1');
    expect(entries[1].id).toBe('2');
  });

  test('skips malformed lines', () => {
    const lines = [
      'not json',
      JSON.stringify({ id: '1', timestamp: 't', botId: 'b', tool: 'x', path: 'p', action: 'a', description: '', size: 0, trackOnly: false }),
      '{ broken',
    ];
    const entries = parseEntries(lines);
    expect(entries).toHaveLength(1);
  });

  test('returns [] for empty input', () => {
    expect(parseEntries([])).toEqual([]);
  });

  test('skips well-formed JSON that is not a production entry', () => {
    const lines = [
      JSON.stringify({ date: '2026-08-22', type: 'infra', note: 'cron recreated' }),
      JSON.stringify({ id: '1', timestamp: 't', botId: 'b', tool: 'x', path: 'p', action: 'a', description: '', size: 0, trackOnly: false }),
      JSON.stringify({ id: '2', path: 42 }),
      JSON.stringify(['not', 'an', 'object']),
      JSON.stringify(null),
    ];
    const entries = parseEntries(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// filterEntries
// ---------------------------------------------------------------------------

describe('filterEntries', () => {
  const entries: ProductionEntry[] = [
    entry({ id: '1', timestamp: '2025-01-01T00:00:00.000Z', botId: 'bot1', path: 'a.md' }),
    entry({ id: '2', timestamp: '2025-02-01T00:00:00.000Z', botId: 'bot1', path: 'b.md' }),
    entry({ id: '3', timestamp: '2025-03-01T00:00:00.000Z', botId: 'bot2', path: 'c.md' }),
    entry({ id: '4', timestamp: '2025-04-01T00:00:00.000Z', botId: 'bot1', path: 'd.md', evaluation: { status: 'approved', evaluatedAt: '2025-04-01T00:00:00.000Z' } }),
    entry({ id: '5', timestamp: '2025-05-01T00:00:00.000Z', botId: 'bot1', path: 'e.md', evaluation: { status: 'rejected', evaluatedAt: '2025-05-01T00:00:00.000Z' } }),
  ];

  test('filters by since (>= timestamp)', () => {
    const filtered = filterEntries(entries, { since: '2025-02-15T00:00:00.000Z' });
    expect(filtered.map((e) => e.id)).toEqual(['3', '4', '5']);
  });

  test('filters by status=approved', () => {
    const filtered = filterEntries(entries, { status: 'approved' });
    expect(filtered.map((e) => e.id)).toEqual(['4']);
  });

  test('filters by status=rejected', () => {
    const filtered = filterEntries(entries, { status: 'rejected' });
    expect(filtered.map((e) => e.id)).toEqual(['5']);
  });

  test('filters by status=unreviewed (no evaluation.status)', () => {
    const filtered = filterEntries(entries, { status: 'unreviewed' });
    expect(filtered.map((e) => e.id)).toEqual(['1', '2', '3']);
  });

  test('filters by botId', () => {
    const filtered = filterEntries(entries, { botId: 'bot2' });
    expect(filtered.map((e) => e.id)).toEqual(['3']);
  });

  test('combines filters (since + status + botId)', () => {
    const filtered = filterEntries(entries, { since: '2025-02-15T00:00:00.000Z', status: 'approved', botId: 'bot1' });
    expect(filtered.map((e) => e.id)).toEqual(['4']);
  });

  test('no opts returns all entries', () => {
    expect(filterEntries(entries, {})).toHaveLength(5);
    expect(filterEntries(entries)).toHaveLength(5);
  });

  test('does not mutate the input array', () => {
    const snapshot = [...entries];
    filterEntries(entries, { since: '2025-02-15T00:00:00.000Z' });
    expect(entries).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// sortByTimestamp
// ---------------------------------------------------------------------------

describe('sortByTimestamp', () => {
  const entries: ProductionEntry[] = [
    entry({ id: '1', timestamp: '2025-01-01T00:00:00.000Z' }),
    entry({ id: '3', timestamp: '2025-03-01T00:00:00.000Z' }),
    entry({ id: '2', timestamp: '2025-02-01T00:00:00.000Z' }),
  ];

  test('default order is desc (newest first)', () => {
    const sorted = sortByTimestamp(entries);
    expect(sorted.map((e) => e.id)).toEqual(['3', '2', '1']);
  });

  test('explicit order=desc', () => {
    const sorted = sortByTimestamp(entries, 'desc');
    expect(sorted.map((e) => e.id)).toEqual(['3', '2', '1']);
  });

  test('order=asc (oldest first)', () => {
    const sorted = sortByTimestamp(entries, 'asc');
    expect(sorted.map((e) => e.id)).toEqual(['1', '2', '3']);
  });

  test('does not mutate the input array', () => {
    const snapshot = entries.map((e) => e.id);
    sortByTimestamp(entries);
    expect(entries.map((e) => e.id)).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// filterApproved / filterRejected
// ---------------------------------------------------------------------------

describe('filterApproved', () => {
  test('returns only entries with evaluation.status === approved', () => {
    const entries: ProductionEntry[] = [
      entry({ id: '1' }),
      entry({ id: '2', evaluation: { status: 'approved', evaluatedAt: 't' } }),
      entry({ id: '3', evaluation: { status: 'rejected', evaluatedAt: 't' } }),
      entry({ id: '4', evaluation: { status: 'approved', evaluatedAt: 't' } }),
    ];
    const approved = filterApproved(entries);
    expect(approved.map((e) => e.id)).toEqual(['2', '4']);
  });
});

describe('filterRejected', () => {
  test('returns only entries with evaluation.status === rejected', () => {
    const entries: ProductionEntry[] = [
      entry({ id: '1' }),
      entry({ id: '2', evaluation: { status: 'approved', evaluatedAt: 't' } }),
      entry({ id: '3', evaluation: { status: 'rejected', evaluatedAt: 't' } }),
    ];
    const rejected = filterRejected(entries);
    expect(rejected.map((e) => e.id)).toEqual(['3']);
  });
});

// ---------------------------------------------------------------------------
// getStatsFromEntries
// ---------------------------------------------------------------------------

describe('getStatsFromEntries', () => {
  test('counts approved, rejected, unreviewed, checked and avgRating', () => {
    const entries: ProductionEntry[] = [
      entry({ id: '1' }),
      entry({ id: '2', evaluation: { status: 'approved', rating: 4, evaluatedAt: 't' } }),
      entry({ id: '3', evaluation: { status: 'approved', rating: 5, evaluatedAt: 't' } }),
      entry({ id: '4', evaluation: { status: 'rejected', rating: 1, evaluatedAt: 't' } }),
      entry({ id: '5', coherenceCheck: { coherent: true, issues: [], checkedAt: 't' } }),
    ];
    const stats = getStatsFromEntries(entries);
    expect(stats.total).toBe(5);
    expect(stats.approved).toBe(2);
    expect(stats.rejected).toBe(1);
    expect(stats.unreviewed).toBe(2);
    expect(stats.checked).toBe(1);
    expect(stats.avgRating).toBe(3.3); // (4+5+1)/3 = 3.333.. rounded to 3.3
  });

  test('returns zeros + null for empty input', () => {
    const stats = getStatsFromEntries([]);
    expect(stats).toEqual({
      total: 0,
      approved: 0,
      rejected: 0,
      unreviewed: 0,
      checked: 0,
      avgRating: null,
    });
  });

  test('avgRating is null when no ratings exist', () => {
    const entries: ProductionEntry[] = [entry({ id: '1' })];
    const stats = getStatsFromEntries(entries);
    expect(stats.avgRating).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializeEntries
// ---------------------------------------------------------------------------

describe('serializeEntries', () => {
  test('returns JSONL with trailing newline', () => {
    const entries: ProductionEntry[] = [
      entry({ id: '1', path: 'a.md' }),
      entry({ id: '2', path: 'b.md' }),
    ];
    const out = serializeEntries(entries);
    expect(out).toBe(`${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n`);
  });

  test('returns empty string for empty array', () => {
    expect(serializeEntries([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// readEntries / writeEntries / appendEntry
// ---------------------------------------------------------------------------

describe('readEntries', () => {
  test('returns [] when file does not exist', () => {
    const path = join(TEMP_DIR, 'missing.jsonl');
    expect(readEntries(path)).toEqual([]);
  });

  test('parses JSONL file', () => {
    const path = join(TEMP_DIR, 'changelog.jsonl');
    const entries = [entry({ id: '1' }), entry({ id: '2' })];
    const content = `${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n`;
    writeFileSync(path, content, 'utf-8');
    expect(readEntries(path)).toEqual(entries);
  });
});

describe('writeEntries', () => {
  test('writes JSONL content to file', () => {
    const path = join(TEMP_DIR, 'changelog.jsonl');
    const entries = [entry({ id: '1' }), entry({ id: '2' })];
    writeEntries(path, entries);
    const read = readFileSync(path, 'utf-8');
    expect(read).toBe(serializeEntries(entries));
  });

  test('truncates existing file', () => {
    const path = join(TEMP_DIR, 'changelog.jsonl');
    writeFileSync(path, 'stale content\n', 'utf-8');
    writeEntries(path, [entry({ id: '1' })]);
    const read = readFileSync(path, 'utf-8');
    expect(read).not.toContain('stale content');
  });
});

describe('appendEntry', () => {
  test('appends one entry to the JSONL file', () => {
    const path = join(TEMP_DIR, 'changelog.jsonl');
    appendEntry(path, entry({ id: '1' }));
    appendEntry(path, entry({ id: '2' }));
    const entries = readEntries(path);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('1');
    expect(entries[1].id).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// Cycle 6 — public API (the functions that move out of the facade).
// ---------------------------------------------------------------------------

describe('loadChangelog', () => {
  test('returns [] when the changelog does not exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(loadChangelog(dir)).toEqual([]);
  });

  test('returns all entries sorted newest-first when no opts are given', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '1', timestamp: '2025-01-01T00:00:00.000Z' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '2', timestamp: '2025-02-01T00:00:00.000Z' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '3', timestamp: '2025-03-01T00:00:00.000Z' }));

    const result = loadChangelog(dir);
    expect(result.map((e) => e.id)).toEqual(['3', '2', '1']);
  });

  test('applies since filter', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '1', timestamp: '2025-01-01T00:00:00.000Z' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '2', timestamp: '2025-02-01T00:00:00.000Z' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '3', timestamp: '2025-03-01T00:00:00.000Z' }));

    const result = loadChangelog(dir, { since: '2025-02-15T00:00:00.000Z' });
    expect(result.map((e) => e.id)).toEqual(['3']);
  });

  test('applies status filter', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '1' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '2', evaluation: { status: 'approved', evaluatedAt: 't' } }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '3', evaluation: { status: 'rejected', evaluatedAt: 't' } }));

    const approved = loadChangelog(dir, { status: 'approved' });
    expect(approved.map((e) => e.id)).toEqual(['2']);

    const rejected = loadChangelog(dir, { status: 'rejected' });
    expect(rejected.map((e) => e.id)).toEqual(['3']);

    const unreviewed = loadChangelog(dir, { status: 'unreviewed' });
    expect(unreviewed.map((e) => e.id)).toEqual(['1']);
  });

  test('applies limit and offset', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      appendEntry(join(dir, 'changelog.jsonl'), entry({ id: String(i), timestamp: `2025-01-0${i}T00:00:00.000Z` }));
    }

    const result = loadChangelog(dir, { limit: 2, offset: 1 });
    expect(result.map((e) => e.id)).toEqual(['4', '3']);
  });
});

describe('loadEntry', () => {
  test('returns the entry whose id matches', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: 'a' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: 'b' }));

    const result = loadEntry(dir, 'b');
    expect(result?.id).toBe('b');
  });

  test('returns null when the entry does not exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: 'a' }));

    expect(loadEntry(dir, 'missing')).toBeNull();
  });

  test('returns null when the changelog does not exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(loadEntry(dir, 'a')).toBeNull();
  });
});

describe('loadStats', () => {
  test('returns the same output as getStatsFromEntries', () => {
    const entries = [
      entry({ id: '1' }),
      entry({ id: '2', evaluation: { status: 'approved', rating: 4, evaluatedAt: 't' } }),
      entry({ id: '3', evaluation: { status: 'rejected', rating: 2, evaluatedAt: 't' } }),
    ];
    expect(loadStats(entries)).toEqual(getStatsFromEntries(entries));
  });
});

describe('loadAllEntries', () => {
  test('aggregates entries from multiple bot dirs', () => {
    const dir1 = join(TEMP_DIR, 'bot1');
    const dir2 = join(TEMP_DIR, 'bot2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    appendEntry(join(dir1, 'changelog.jsonl'), entry({ id: '1', botId: 'bot1', timestamp: '2025-01-01T00:00:00.000Z' }));
    appendEntry(join(dir2, 'changelog.jsonl'), entry({ id: '2', botId: 'bot2', timestamp: '2025-02-01T00:00:00.000Z' }));

    const result = loadAllEntries([dir1, dir2]);
    expect(result.map((e) => e.id).sort()).toEqual(['1', '2']);
  });

  test('applies since filter across all bots', () => {
    const dir1 = join(TEMP_DIR, 'bot1');
    const dir2 = join(TEMP_DIR, 'bot2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    appendEntry(join(dir1, 'changelog.jsonl'), entry({ id: '1', timestamp: '2025-01-01T00:00:00.000Z' }));
    appendEntry(join(dir2, 'changelog.jsonl'), entry({ id: '2', timestamp: '2025-02-01T00:00:00.000Z' }));

    const result = loadAllEntries([dir1, dir2], { since: '2025-01-15T00:00:00.000Z' });
    expect(result.map((e) => e.id)).toEqual(['2']);
  });

  test('applies status filter across all bots', () => {
    const dir1 = join(TEMP_DIR, 'bot1');
    const dir2 = join(TEMP_DIR, 'bot2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    appendEntry(join(dir1, 'changelog.jsonl'), entry({ id: '1' }));
    appendEntry(join(dir2, 'changelog.jsonl'), entry({ id: '2', evaluation: { status: 'approved', evaluatedAt: 't' } }));

    const result = loadAllEntries([dir1, dir2], { status: 'approved' });
    expect(result.map((e) => e.id)).toEqual(['2']);
  });

  test('applies limit and offset to the merged result', () => {
    const dir1 = join(TEMP_DIR, 'bot1');
    const dir2 = join(TEMP_DIR, 'bot2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    appendEntry(join(dir1, 'changelog.jsonl'), entry({ id: '1', timestamp: '2025-01-01T00:00:00.000Z' }));
    appendEntry(join(dir2, 'changelog.jsonl'), entry({ id: '2', timestamp: '2025-02-01T00:00:00.000Z' }));
    appendEntry(join(dir1, 'changelog.jsonl'), entry({ id: '3', timestamp: '2025-03-01T00:00:00.000Z' }));

    // Slice happens at the facade. loadAllEntries returns all sorted.
    const all = loadAllEntries([dir1, dir2]);
    expect(all.map((e) => e.id)).toEqual(['3', '2', '1']);
  });

  test('skips missing bot dirs', () => {
    const result = loadAllEntries([join(TEMP_DIR, 'nonexistent')]);
    expect(result).toEqual([]);
  });
});

describe('append', () => {
  test('append alias for appendEntry (public API name)', () => {
    const path = join(TEMP_DIR, 'changelog.jsonl');
    append(path, entry({ id: '1' }));
    append(path, entry({ id: '2' }));
    const entries = readEntries(path);
    expect(entries).toHaveLength(2);
  });
});

describe('updateEntry', () => {
  test('reads, mutates, writes the matched entry; returns the updated entry', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: 'a', path: 'a.md' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: 'b', path: 'b.md' }));

    const result = updateEntry(dir, 'b', (e) => {
      e.evaluation = { status: 'approved', evaluatedAt: '2025-01-01' };
    });
    expect(result?.id).toBe('b');
    expect(result?.evaluation?.status).toBe('approved');

    // Other entries untouched.
    const all = readEntries(join(dir, 'changelog.jsonl'));
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe('a');
    expect(all[0].evaluation).toBeUndefined();
    expect(all[1].id).toBe('b');
    expect(all[1].evaluation?.status).toBe('approved');
  });

  test('returns null when the entry does not exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(updateEntry(dir, 'missing', () => {})).toBeNull();
  });

  test('returns null when the changelog does not exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(updateEntry(dir, 'a', () => {})).toBeNull();
  });

  test('mutator is not called when the entry is missing', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    let called = false;
    updateEntry(dir, 'missing', () => {
      called = true;
    });
    expect(called).toBe(false);
  });
});

describe('removeEntriesByPath', () => {
  test('removes entries whose path matches exactly', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '1', path: 'a.md' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '2', path: 'b.md' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '3', path: 'a.md' }));

    const removed = removeEntriesByPath(dir, 'a.md');
    expect(removed).toBe(2);

    const remaining = readEntries(join(dir, 'changelog.jsonl'));
    expect(remaining.map((e) => e.id)).toEqual(['2']);
  });

  test('removes entries whose path starts with the relativeDir prefix (directory case)', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '1', path: 'sub/a.md' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '2', path: 'sub/b.md' }));
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '3', path: 'other.md' }));

    const removed = removeEntriesByPath(dir, 'sub');
    expect(removed).toBe(2);

    const remaining = readEntries(join(dir, 'changelog.jsonl'));
    expect(remaining.map((e) => e.id)).toEqual(['3']);
  });

  test('returns 0 when nothing matches', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    appendEntry(join(dir, 'changelog.jsonl'), entry({ id: '1', path: 'a.md' }));

    const removed = removeEntriesByPath(dir, 'nothing.md');
    expect(removed).toBe(0);
  });

  test('returns 0 when the changelog does not exist', () => {
    const dir = join(TEMP_DIR, 'bot1');
    mkdirSync(dir, { recursive: true });
    expect(removeEntriesByPath(dir, 'a.md')).toBe(0);
  });
});

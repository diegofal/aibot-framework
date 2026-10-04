/**
 * Cycle 8 — tree.ts Red tests.
 *
 * Pinning the contract of src/productions/tree.ts. Per
 * docs/architecture-docs/productions-refactor.md §6, this module
 * extracts the directory walking logic from ProductionsService.getDirectoryTree.
 *
 * Module boundary:
 *   - walkTree(rootDir, entryMap, excludes) → TreeNode[]
 *     Walks the directory tree starting at rootDir. For each file,
 *     enriches with the entry's metadata from entryMap (entryId,
 *     description, evaluation, coherenceCheck). Excludes directories
 *     in the excludes set at every level.
 *   - Pure I/O: does node:fs readdirSync + statSync. Returns [] when
 *     the root directory does not exist.
 *
 * Per-function coverage: pin each branch (missing dir, empty dir,
 * nested dirs, excluded entries, enrichment).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEntryMap, walkTree } from '../../src/productions/tree';
import type { ProductionEntry } from '../../src/productions/types';

const TEMP_DIR = join(process.cwd(), '.test-productions-tree');

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
// walkTree
// ---------------------------------------------------------------------------

describe('walkTree', () => {
  test('returns [] when root directory does not exist', () => {
    const result = walkTree({ dir: join(TEMP_DIR, 'missing'), entryMap: new Map(), excludes: new Set() });
    expect(result).toEqual([]);
  });

  test('returns [] for an empty directory', () => {
    const dir = join(TEMP_DIR, 'empty');
    mkdirSync(dir, { recursive: true });
    const result = walkTree({ dir, entryMap: new Map(), excludes: new Set() });
    expect(result).toEqual([]);
  });

  test('returns a single file node for a flat directory', () => {
    const dir = join(TEMP_DIR, 'flat');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), 'content', 'utf-8');

    const result = walkTree({ dir, entryMap: new Map(), excludes: new Set() });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'a.md',
      path: 'a.md',
      type: 'file',
    });
    expect(result[0].size).toBe(7);
  });

  test('skips excluded entries at the root', () => {
    const dir = join(TEMP_DIR, 'root-excludes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), 'content', 'utf-8');
    writeFileSync(join(dir, 'changelog.jsonl'), 'log', 'utf-8');
    writeFileSync(join(dir, 'index.html'), 'html', 'utf-8');

    const result = walkTree({
      dir,
      entryMap: new Map(),
      excludes: new Set(['changelog.jsonl', 'index.html']),
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('a.md');
  });

  test('skips excluded entries at every level (recurse into subdirs)', () => {
    const dir = join(TEMP_DIR, 'nested-excludes');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub/a.md'), 'x', 'utf-8');
    writeFileSync(join(dir, 'sub/notes.txt'), 'y', 'utf-8');

    const result = walkTree({
      dir,
      entryMap: new Map(),
      excludes: new Set(['notes.txt']),
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('sub');
    expect(result[0].type).toBe('dir');
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children![0].name).toBe('a.md');
  });

  test('walks nested directories with relative paths', () => {
    const dir = join(TEMP_DIR, 'nested');
    mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'deep', 'leaf.md'), 'x', 'utf-8');

    const result = walkTree({ dir, entryMap: new Map(), excludes: new Set() });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('sub');
    expect(result[0].type).toBe('dir');
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children![0].name).toBe('deep');
    expect(result[0].children![0].type).toBe('dir');
    expect(result[0].children![0].children).toHaveLength(1);
    expect(result[0].children![0].children![0]).toMatchObject({
      name: 'leaf.md',
      path: 'sub/deep/leaf.md',
      type: 'file',
    });
  });

  test('enriches file nodes from entryMap', () => {
    const dir = join(TEMP_DIR, 'enrich');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'r.md'), 'x', 'utf-8');

    const entryMap = new Map<string, ProductionEntry>();
    entryMap.set('r.md', entry({
      id: 'entry-1',
      path: 'r.md',
      description: 'a report',
      evaluation: { status: 'approved', rating: 5, evaluatedAt: '2025-01-01' },
    }));

    const result = walkTree({ dir, entryMap, excludes: new Set() });
    expect(result).toHaveLength(1);
    expect(result[0].entryId).toBe('entry-1');
    expect(result[0].description).toBe('a report');
    expect(result[0].evaluation).toEqual({ status: 'approved', rating: 5 });
  });

  test('enriches file nodes with coherenceCheck', () => {
    const dir = join(TEMP_DIR, 'coherence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'r.md'), 'x', 'utf-8');

    const entryMap = new Map<string, ProductionEntry>();
    entryMap.set('r.md', entry({
      id: 'e',
      path: 'r.md',
      coherenceCheck: { coherent: true, issues: [], checkedAt: 't' },
    }));

    const result = walkTree({ dir, entryMap, excludes: new Set() });
    expect(result[0].coherenceCheck).toEqual({ coherent: true });
  });

  test('does not enrich when no entry exists', () => {
    const dir = join(TEMP_DIR, 'no-enrich');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'r.md'), 'x', 'utf-8');

    const result = walkTree({ dir, entryMap: new Map(), excludes: new Set() });
    expect(result[0].entryId).toBeUndefined();
    expect(result[0].description).toBeUndefined();
    expect(result[0].evaluation).toBeUndefined();
    expect(result[0].coherenceCheck).toBeUndefined();
  });

  test('directory nodes have no entryId/description fields', () => {
    const dir = join(TEMP_DIR, 'pure-dir');
    mkdirSync(join(dir, 'sub'), { recursive: true });

    const entryMap = new Map<string, ProductionEntry>();
    // Unrelated entry — should not contaminate directory nodes.
    entryMap.set('sub', entry({ id: 'sneak', path: 'sub' }));

    const result = walkTree({ dir, entryMap, excludes: new Set() });
    expect(result[0].name).toBe('sub');
    expect(result[0].type).toBe('dir');
    expect(result[0].entryId).toBeUndefined();
  });

  test('sorts entries alphabetically', () => {
    const dir = join(TEMP_DIR, 'sort');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'z.md'), 'z', 'utf-8');
    writeFileSync(join(dir, 'a.md'), 'a', 'utf-8');
    writeFileSync(join(dir, 'm.md'), 'm', 'utf-8');

    const result = walkTree({ dir, entryMap: new Map(), excludes: new Set() });
    expect(result.map((n) => n.name)).toEqual(['a.md', 'm.md', 'z.md']);
  });
});

// ---------------------------------------------------------------------------
// buildEntryMap (Cycle 8c — extracted from the facade)
// ---------------------------------------------------------------------------

describe('buildEntryMap', () => {
  test('returns empty map for missing changelog', () => {
    const dir = join(TEMP_DIR, 'no-changelog');
    mkdirSync(dir, { recursive: true });
    const result = buildEntryMap(dir);
    expect(result.size).toBe(0);
  });

  test('keeps the newest entry per path (later lines win)', () => {
    const dir = join(TEMP_DIR, 'newest');
    mkdirSync(dir, { recursive: true });
    const older = entry({ id: 'older', path: 'a.md' });
    const newer = entry({ id: 'newer', path: 'a.md' });
    writeFileSync(join(dir, 'changelog.jsonl'), `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`, 'utf-8');

    const result = buildEntryMap(dir);
    expect(result.get('a.md')?.id).toBe('newer');
  });

  test('skips entries with absolute paths (review-4 B1)', () => {
    const dir = join(TEMP_DIR, 'absolute');
    mkdirSync(dir, { recursive: true });
    const rel = entry({ id: 'rel', path: 'a.md' });
    const abs = entry({ id: 'abs', path: '/etc/passwd' });
    writeFileSync(join(dir, 'changelog.jsonl'), `${JSON.stringify(rel)}\n${JSON.stringify(abs)}\n`, 'utf-8');

    const result = buildEntryMap(dir);
    expect(result.size).toBe(1);
    expect(result.has('a.md')).toBe(true);
  });

  test('skips lines without a string path instead of throwing', () => {
    // Agents append free-form notes to changelog.jsonl (no `path` key).
    // isAbsolute(undefined) used to throw and take the whole tree down.
    const dir = join(TEMP_DIR, 'pathless');
    mkdirSync(dir, { recursive: true });
    const good = entry({ id: 'good', path: 'a.md' });
    const note = { date: '2026-08-22', type: 'infra', note: 'cron recreated' };
    const numeric = { ...entry({ id: 'numeric' }), path: 42 };
    writeFileSync(
      join(dir, 'changelog.jsonl'),
      `${JSON.stringify(note)}
${JSON.stringify(good)}
${JSON.stringify(numeric)}
`,
      'utf-8'
    );

    const result = buildEntryMap(dir);
    expect(result.size).toBe(1);
    expect(result.get('a.md')?.id).toBe('good');
  });
});

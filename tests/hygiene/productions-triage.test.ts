import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { productionsTriage } from '../../src/hygiene/routines/productions-triage';
import { readEntries } from '../../src/productions/changelog';
import type { ProductionEntry } from '../../src/productions/types';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';
import { isoDaysAgo, makeCtx, writeFile } from './helpers';

let root: string;
let workDir: string;

beforeEach(() => {
  root = createTempDir('hygiene-prod');
  workDir = join(root, 'productions', 'bot1');
});

afterEach(() => {
  removeTempDir(root);
});

function entry(overrides: Partial<ProductionEntry>): ProductionEntry {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: isoDaysAgo(1),
    botId: 'bot1',
    tool: 'file_write',
    path: '01_thing.md',
    action: 'create',
    description: 'x',
    size: 100,
    trackOnly: false,
    ...overrides,
  };
}

function changelog(entries: ProductionEntry[]): void {
  writeFile(
    join(workDir, 'changelog.jsonl'),
    `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`
  );
}

describe('productions-triage metadata', () => {
  test('is bot-scoped, applicable, and silent on a missing dir', () => {
    expect(productionsTriage.id).toBe('productions-triage');
    expect(productionsTriage.scope).toBe('bot');
    expect(productionsTriage.canApply).toBe(true);
    expect(productionsTriage.preview(makeCtx(root, { workDir }))).toEqual([]);
  });
});

describe('unreviewed-stale', () => {
  test('reports unreviewed files older than 7 days and leaves reviewed or fresh ones alone', () => {
    writeFile(join(workDir, '01_old.md'), 'old content that is long enough to matter'.repeat(3));
    writeFile(
      join(workDir, '02_fresh.md'),
      'fresh content that is long enough to matter'.repeat(3)
    );
    writeFile(join(workDir, '03_approved.md'), 'approved content that is long enough'.repeat(3));
    changelog([
      entry({ path: '01_old.md', timestamp: isoDaysAgo(10) }),
      entry({ path: '02_fresh.md', timestamp: isoDaysAgo(1) }),
      entry({
        path: '03_approved.md',
        timestamp: isoDaysAgo(20),
        evaluation: { status: 'approved', evaluatedAt: isoDaysAgo(19) },
      }),
    ]);
    const findings = productionsTriage.preview(makeCtx(root, { workDir }));
    const stale = findings.filter((f) => f.kind === 'unreviewed-stale');
    expect(stale.map((f) => f.file)).toEqual(['01_old.md']);
    expect(stale[0].fixable).toBe(true);
    expect(stale[0].fix?.action).toBe('archive');
  });

  test('honours options.staleDays', () => {
    writeFile(
      join(workDir, '01_old.md'),
      'content content content content content content content'
    );
    changelog([entry({ path: '01_old.md', timestamp: isoDaysAgo(3) })]);
    expect(
      productionsTriage
        .preview(makeCtx(root, { workDir, options: { staleDays: 2 } }))
        .map((f) => f.kind)
    ).toEqual(['unreviewed-stale']);
    expect(productionsTriage.preview(makeCtx(root, { workDir }))).toEqual([]);
  });

  test('apply skips archiving unless options.archiveStale is true', () => {
    writeFile(
      join(workDir, '01_old.md'),
      'content content content content content content content'
    );
    changelog([entry({ path: '01_old.md', timestamp: isoDaysAgo(10) })]);
    const ctx = makeCtx(root, { workDir });
    const findings = productionsTriage.preview(ctx);
    const skipped = productionsTriage.apply(ctx, findings);
    expect(skipped.applied).toHaveLength(0);
    expect(skipped.skipped[0].reason).toMatch(/archiveStale/);
    expect(existsSync(join(workDir, '01_old.md'))).toBe(true);

    const ctx2 = makeCtx(root, { workDir, options: { archiveStale: true } });
    const result = productionsTriage.apply(ctx2, findings);
    expect(result.applied).toHaveLength(1);
    expect(existsSync(join(workDir, '01_old.md'))).toBe(false);
    expect(existsSync(join(workDir, 'archived', '01_old.md'))).toBe(true);
    const entries = readEntries(join(workDir, 'changelog.jsonl'));
    const archived = entries.find((e) => e.action === 'archive');
    expect(archived).toMatchObject({ botId: 'bot1', archivedFrom: '01_old.md' });
    expect(archived!.archiveReason).toContain('productions-triage');
  });
});

describe('duplicate-number', () => {
  test('reports two root files sharing the NN_ prefix', () => {
    writeFile(join(workDir, '01_a.md'), 'a');
    writeFile(join(workDir, '01_b.md'), 'b');
    writeFile(join(workDir, '02_c.md'), 'c');
    const findings = productionsTriage.preview(makeCtx(root, { workDir }));
    const dup = findings.filter((f) => f.kind === 'duplicate-number');
    expect(dup).toHaveLength(1);
    expect(dup[0].message).toContain('01_a.md');
    expect(dup[0].message).toContain('01_b.md');
    expect(dup[0].fixable).toBe(false);
  });
});

describe('orphan-reference', () => {
  test('reports changelog paths that no longer exist on disk', () => {
    writeFile(join(workDir, '01_here.md'), 'here');
    changelog([
      entry({ path: '01_here.md' }),
      entry({ path: '02_gone.md' }),
      entry({ path: '/abs/elsewhere.md', trackOnly: true }),
      entry({ path: 'archived/03_x.md', action: 'archive', archivedFrom: '03_x.md' }),
    ]);
    const findings = productionsTriage.preview(makeCtx(root, { workDir }));
    const orphans = findings.filter((f) => f.kind === 'orphan-reference');
    expect(orphans.map((f) => f.file)).toEqual(['02_gone.md']);
    expect(orphans[0].fixable).toBe(true);
    expect(orphans[0].fix?.action).toBe('prune-changelog');
    expect(orphans[0].fix?.details).toMatch(/pruneOrphans/);
  });

  test('a non-trackOnly path outside the productions dir is untracked, not fixable', () => {
    changelog([entry({ path: '/abs/elsewhere.md', trackOnly: false })]);
    const [orphan] = productionsTriage
      .preview(makeCtx(root, { workDir }))
      .filter((f) => f.kind === 'orphan-reference');
    expect(orphan.file).toBe('/abs/elsewhere.md');
    expect(orphan.fixable).toBe(false);
    expect(orphan.fix).toBeUndefined();
  });

  test('apply prunes nothing and writes nothing without options.pruneOrphans', () => {
    writeFile(join(workDir, '01_here.md'), 'here');
    changelog([entry({ path: '01_here.md' }), entry({ path: '02_gone.md' })]);
    const changelogPath = join(workDir, 'changelog.jsonl');
    const before = readFileSync(changelogPath, 'utf-8');

    const ctx = makeCtx(root, { workDir });
    const findings = productionsTriage.preview(ctx).filter((f) => f.kind === 'orphan-reference');
    const result = productionsTriage.apply(ctx, findings);

    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toEqual([
      { findingId: 'productions-triage:orphan-reference:02_gone.md', reason: 'report only' },
    ]);
    expect(result.backups).toEqual([]);
    expect(readFileSync(changelogPath, 'utf-8')).toBe(before);
    expect(existsSync(join(workDir, '.versions'))).toBe(false);
  });

  test('apply with options.pruneOrphans drops the orphan entries, backs up and leaves the rest byte-for-byte', () => {
    writeFile(join(workDir, '01_here.md'), 'here');
    const keepA = entry({ path: '01_here.md', description: 'kept' });
    const gone = entry({ path: '02_gone.md', description: 'orphan' });
    const goneUpdate = entry({ path: '02_gone.md', action: 'update', description: 'orphan too' });
    const tracked = entry({ path: '/abs/elsewhere.md', trackOnly: true });
    const archived = entry({
      path: 'archived/03_x.md',
      action: 'archive',
      archivedFrom: '03_x.md',
    });
    changelog([keepA, gone, tracked, goneUpdate, archived]);
    const changelogPath = join(workDir, 'changelog.jsonl');

    const ctx = makeCtx(root, { workDir, options: { pruneOrphans: true } });
    const findings = productionsTriage.preview(ctx).filter((f) => f.kind === 'orphan-reference');
    expect(findings.map((f) => f.file)).toEqual(['02_gone.md']);

    const result = productionsTriage.apply(ctx, findings);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].action).toBe('prune-changelog');
    expect(result.applied[0].result).toContain('02_gone.md');
    expect(result.skipped).toEqual([]);

    // Surviving lines are the original JSON, untouched and in order.
    const lines = readFileSync(changelogPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toEqual([keepA, tracked, archived].map((e) => JSON.stringify(e)));
    expect(readEntries(changelogPath).map((e) => e.id)).toEqual([
      keepA.id,
      tracked.id,
      archived.id,
    ]);

    // Nothing is lost: the pre-prune changelog is backed up next to the file.
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0]).toContain('changelog.jsonl');
    expect(existsSync(result.backups[0])).toBe(true);
    expect(readFileSync(result.backups[0], 'utf-8').split('\n').filter(Boolean)).toHaveLength(5);
  });

  test('a changelog that is entirely orphans is left valid and empty', () => {
    const gone = entry({ path: '02_gone.md' });
    changelog([gone]);
    const changelogPath = join(workDir, 'changelog.jsonl');

    const ctx = makeCtx(root, { workDir, options: { pruneOrphans: true } });
    const findings = productionsTriage.preview(ctx);
    const result = productionsTriage.apply(ctx, findings);

    expect(result.applied).toHaveLength(1);
    expect(existsSync(changelogPath)).toBe(true);
    expect(readFileSync(changelogPath, 'utf-8')).toBe('');
    expect(readEntries(changelogPath)).toEqual([]);
  });

  test('an orphan whose file reappeared between preview and apply is skipped', () => {
    changelog([entry({ path: '02_gone.md' })]);
    const ctx = makeCtx(root, { workDir, options: { pruneOrphans: true } });
    const findings = productionsTriage.preview(ctx);
    writeFile(join(workDir, '02_gone.md'), 'back again');

    const result = productionsTriage.apply(ctx, findings);
    expect(result.applied).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/no changelog entry/i);
    expect(readEntries(join(workDir, 'changelog.jsonl'))).toHaveLength(1);
  });

  test('malformed changelog lines survive a prune', () => {
    const gone = entry({ path: '02_gone.md' });
    writeFile(join(workDir, 'changelog.jsonl'), `not json at all\n${JSON.stringify(gone)}\n`);
    const ctx = makeCtx(root, { workDir, options: { pruneOrphans: true } });
    const result = productionsTriage.apply(ctx, productionsTriage.preview(ctx));
    expect(result.applied).toHaveLength(1);
    expect(readFileSync(join(workDir, 'changelog.jsonl'), 'utf-8')).toBe('not json at all\n');
  });

  test('ignores bookkeeping entries that carry no path (e.g. action "infra")', () => {
    writeFile(join(workDir, '01_here.md'), 'here');
    changelog([
      entry({ path: '01_here.md' }),
      { ...entry({ path: '01_here.md' }), action: 'infra', path: undefined } as ProductionEntry,
    ]);
    const findings = productionsTriage.preview(makeCtx(root, { workDir }));
    expect(findings.filter((f) => f.kind === 'routine-error')).toEqual([]);
    expect(findings.filter((f) => f.kind === 'orphan-reference')).toEqual([]);
  });
});

describe('unnumbered', () => {
  test('reports root md files without a NN_ prefix, ignoring index files', () => {
    writeFile(join(workDir, 'notes.md'), 'n');
    writeFile(join(workDir, '01_ok.md'), 'ok');
    writeFile(join(workDir, 'INDEX.md'), 'idx');
    writeFile(join(workDir, 'sub', 'deep.md'), 'deep');
    const findings = productionsTriage.preview(makeCtx(root, { workDir }));
    expect(findings.filter((f) => f.kind === 'unnumbered').map((f) => f.file)).toEqual([
      'notes.md',
    ]);
  });
});

describe('cleanup-candidate', () => {
  test('surfaces analyzeCleanup candidates as report-only findings', () => {
    writeFile(join(workDir, '01_tiny.md'), 'x');
    const { utimesSync } = require('node:fs');
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(workDir, '01_tiny.md'), old, old);
    changelog([entry({ path: '01_tiny.md', timestamp: isoDaysAgo(1) })]);
    const ctx = makeCtx(root, { workDir });
    ctx.now = new Date();
    const findings = productionsTriage.preview(ctx);
    const c = findings.filter((f) => f.kind === 'cleanup-candidate');
    expect(c).toHaveLength(1);
    expect(c[0].file).toBe('01_tiny.md');
    expect(c[0].fixable).toBe(false);
  });
});

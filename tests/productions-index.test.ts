import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../src/config';
import { ProductionsService } from '../src/productions/service';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

const TEST_DIR = join(process.cwd(), '.test-productions-index');

function makeConfig(): Config {
  return {
    bots: [
      {
        id: 'testbot',
        name: 'Test Bot',
        token: '',
        enabled: true,
        skills: [],
        productions: { enabled: true, trackOnly: false },
      },
    ],
    productions: {
      enabled: true,
      baseDir: TEST_DIR,
    },
  } as Config;
}

describe('ProductionsService — rebuildIndex', () => {
  let service: ProductionsService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new ProductionsService(makeConfig(), noopLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('generates INDEX.md with correct header', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'hello.md'), '# Hello World\nSome content', 'utf-8');

    service.rebuildIndex('testbot');

    const indexPath = join(dir, 'INDEX.md');
    expect(existsSync(indexPath)).toBe(true);

    const content = readFileSync(indexPath, 'utf-8');
    expect(content).toContain('# Production Index — testbot');
    expect(content).toContain('**Files:**');
    expect(content).toContain('**Directories:**');
  });

  test('lists root files in Root section', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'report.md'), '# My Report\nDetails here', 'utf-8');
    writeFileSync(join(dir, 'notes.txt'), 'Some notes', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('## Root');
    expect(content).toContain('report.md');
    expect(content).toContain('notes.txt');
  });

  test('groups files by subdirectory', () => {
    const dir = service.resolveDir('testbot');
    mkdirSync(join(dir, 'research'), { recursive: true });
    writeFileSync(join(dir, 'research', 'findings.md'), '# Research Findings', 'utf-8');
    writeFileSync(join(dir, 'root_file.md'), '# Root File', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('## Root');
    expect(content).toContain('## research/');
    expect(content).toContain('findings.md');
    expect(content).toContain('root_file.md');
  });

  test('uses first heading as description for markdown files', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'doc.md'), '# Pipeline Tracker for Jobs\nContent here', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('Pipeline Tracker for Jobs');
  });

  test('uses changelog description when available', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'output.md'), '# Some heading\nContent', 'utf-8');

    // Log a production with a custom description
    service.logProduction({
      timestamp: new Date().toISOString(),
      botId: 'testbot',
      tool: 'file_write',
      path: 'output.md',
      action: 'create',
      description: 'Custom description from changelog',
      size: 100,
      trackOnly: false,
    });

    // rebuildIndex is called by logProduction, but call again to ensure latest
    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('Custom description from changelog');
  });

  test('falls back to humanized filename when no heading or changelog', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'my_cool_report.md'), 'No heading here, just text.', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('My Cool Report');
  });

  test('excludes INDEX.md, changelog.jsonl, summary.json from listing', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'real_file.md'), '# Real', 'utf-8');
    writeFileSync(join(dir, 'INDEX.md'), 'old index', 'utf-8');
    writeFileSync(join(dir, 'changelog.jsonl'), '{}', 'utf-8');
    writeFileSync(join(dir, 'summary.json'), '{}', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('real_file.md');
    // INDEX.md, changelog.jsonl, summary.json should NOT appear as table rows
    const lines = content.split('\n');
    const tableRows = lines.filter(
      (l) => l.startsWith('|') && !l.startsWith('|--') && !l.includes('File')
    );
    for (const row of tableRows) {
      expect(row).not.toContain('| INDEX.md');
      expect(row).not.toContain('| changelog.jsonl');
      expect(row).not.toContain('| summary.json');
    }
  });

  test('handles empty directory', () => {
    service.resolveDir('testbot');

    service.rebuildIndex('testbot');

    const dir = service.resolveDir('testbot');
    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('**Files:** 0');
  });

  test('logProduction triggers rebuildIndex automatically', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'pre_existing.md'), '# Pre-existing File', 'utf-8');

    service.logProduction({
      timestamp: new Date().toISOString(),
      botId: 'testbot',
      tool: 'file_write',
      path: 'new_file.md',
      action: 'create',
      description: 'New file description',
      size: 50,
      trackOnly: false,
    });

    const indexPath = join(dir, 'INDEX.md');
    expect(existsSync(indexPath)).toBe(true);
    const content = readFileSync(indexPath, 'utf-8');
    expect(content).toContain('pre_existing.md');
  });

  test('formats file sizes correctly', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'tiny.md'), 'x', 'utf-8');
    writeFileSync(join(dir, 'medium.md'), 'x'.repeat(2048), 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    // tiny.md should show bytes, medium.md should show KB
    expect(content).toMatch(/\d+B/);
    expect(content).toMatch(/\d+\.\d+KB/);
  });

  test('skips generic file_write descriptions from changelog', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'report.md'), '# My Report Title\nContent', 'utf-8');

    // Log with generic description
    service.logProduction({
      timestamp: new Date().toISOString(),
      botId: 'testbot',
      tool: 'file_write',
      path: 'report.md',
      action: 'create',
      description: 'file_write: report.md',
      size: 50,
      trackOnly: false,
    });

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    // Should use first heading instead of generic description
    expect(content).toContain('My Report Title');
    // Should NOT show the generic description in the table
    expect(content).not.toContain('| file_write: report.md');
  });
});

describe('ProductionsService — archiveFile', () => {
  let service: ProductionsService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new ProductionsService(makeConfig(), noopLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('moves file to archived/ directory', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'old_report.md'), '# Old Report', 'utf-8');

    const ok = service.archiveFile('testbot', 'old_report.md', 'Superseded by new_report.md');
    expect(ok).toBe(true);

    expect(existsSync(join(dir, 'old_report.md'))).toBe(false);
    expect(existsSync(join(dir, 'archived', 'old_report.md'))).toBe(true);

    // Verify content preserved
    const content = readFileSync(join(dir, 'archived', 'old_report.md'), 'utf-8');
    expect(content).toBe('# Old Report');
  });

  test('creates archived/ directory if it does not exist', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'file.md'), 'content', 'utf-8');

    expect(existsSync(join(dir, 'archived'))).toBe(false);

    service.archiveFile('testbot', 'file.md', 'test reason');

    expect(existsSync(join(dir, 'archived'))).toBe(true);
  });

  test('logs archive action in changelog', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'stale.md'), 'old content', 'utf-8');

    service.archiveFile('testbot', 'stale.md', 'Content is stale');

    const entries = service.getChangelog('testbot');
    const archiveEntry = entries.find((e) => e.action === 'archive');
    expect(archiveEntry).toBeTruthy();
    expect(archiveEntry?.path).toBe('archived/stale.md');
    expect(archiveEntry?.archivedFrom).toBe('stale.md');
    expect(archiveEntry?.archiveReason).toBe('Content is stale');
  });

  test('returns false for non-existent file', () => {
    service.resolveDir('testbot');
    const ok = service.archiveFile('testbot', 'nonexistent.md', 'reason');
    expect(ok).toBe(false);
  });

  test('archives files from subdirectories', () => {
    const dir = service.resolveDir('testbot');
    mkdirSync(join(dir, 'outreach'), { recursive: true });
    writeFileSync(join(dir, 'outreach', 'draft_v1.md'), 'draft content', 'utf-8');

    const ok = service.archiveFile('testbot', 'outreach/draft_v1.md', 'Superseded by v2');
    expect(ok).toBe(true);

    expect(existsSync(join(dir, 'outreach', 'draft_v1.md'))).toBe(false);
    expect(existsSync(join(dir, 'archived', 'draft_v1.md'))).toBe(true);
  });

  test('rebuilds INDEX.md after archiving', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'to_archive.md'), '# To Archive', 'utf-8');
    writeFileSync(join(dir, 'keep.md'), '# Keep', 'utf-8');

    service.archiveFile('testbot', 'to_archive.md', 'Test reason');

    const indexContent = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(indexContent).toContain('## archived/');
    expect(indexContent).toContain('to_archive.md');
    expect(indexContent).toContain('keep.md');
  });

  test('archived section shows reason and original path', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'old.md'), 'old content', 'utf-8');

    service.archiveFile('testbot', 'old.md', 'Replaced by new.md');

    const indexContent = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    // Archived table should have different columns
    expect(indexContent).toContain('Archived From');
    expect(indexContent).toContain('Reason');
    expect(indexContent).toContain('old.md');
    expect(indexContent).toContain('Replaced by new.md');
  });

  test('ProductionEntry type supports archive fields', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'test.md'), 'content', 'utf-8');

    service.archiveFile('testbot', 'test.md', 'Test archive');

    const entries = service.getChangelog('testbot');
    const archiveEntry = entries.find((e) => e.action === 'archive');
    expect(archiveEntry).toBeTruthy();
    expect(archiveEntry?.action).toBe('archive');
    expect(archiveEntry?.archivedFrom).toBe('test.md');
    expect(archiveEntry?.archiveReason).toBe('Test archive');
  });
});

describe('ProductionsService — frontmatter', () => {
  test('injectFrontmatter adds frontmatter to .md file', () => {
    const result = ProductionsService.injectFrontmatter(
      '# My Title\nContent here',
      'report.md',
      '2026-03-03T14:23:00.000Z'
    );
    expect(result).toContain('---\ncreated_at: "2026-03-03T14:23:00.000Z"\n---');
    expect(result).toContain('# My Title');
  });

  test('injectFrontmatter skips non-.md files', () => {
    const original = '{"key": "value"}';
    const result = ProductionsService.injectFrontmatter(original, 'data.json');
    expect(result).toBe(original);
  });

  test('injectFrontmatter skips if already has frontmatter', () => {
    const original = '---\ncreated_at: "2026-01-01T00:00:00Z"\n---\n\n# Title';
    const result = ProductionsService.injectFrontmatter(original, 'doc.md', '2026-03-03T00:00:00Z');
    expect(result).toBe(original);
  });

  test('parseFrontmatter extracts created_at', () => {
    const content = '---\ncreated_at: "2026-03-03T14:23:00.000Z"\n---\n\n# Title';
    const ts = ProductionsService.parseFrontmatter(content);
    expect(ts).toBe('2026-03-03T14:23:00.000Z');
  });

  test('parseFrontmatter returns null when no frontmatter', () => {
    const content = '# Title\nNo frontmatter here';
    expect(ProductionsService.parseFrontmatter(content)).toBeNull();
  });

  test('parseFrontmatter returns null when no created_at field', () => {
    const content = '---\nauthor: "bot"\n---\n\n# Title';
    expect(ProductionsService.parseFrontmatter(content)).toBeNull();
  });
});

describe('ProductionsService — rebuildIndex datetime & chronological', () => {
  let service: ProductionsService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new ProductionsService(makeConfig(), noopLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('rebuildIndex shows datetime not just date', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(
      join(dir, 'report.md'),
      '---\ncreated_at: "2026-03-03T14:23:00.000Z"\n---\n\n# Report\nContent here.',
      'utf-8'
    );

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('2026-03-03 14:23');
  });

  test('rebuildIndex uses frontmatter date over birthtime', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(
      join(dir, 'article.md'),
      '---\ncreated_at: "2025-01-15T09:30:00.000Z"\n---\n\n# Old Article\nWritten in 2025.',
      'utf-8'
    );

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('2025-01-15 09:30');
  });

  test('rebuildIndex includes chronological section', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(
      join(dir, 'first.md'),
      '---\ncreated_at: "2026-01-01T10:00:00.000Z"\n---\n\n# First\nContent.',
      'utf-8'
    );
    writeFileSync(
      join(dir, 'second.md'),
      '---\ncreated_at: "2026-02-01T12:00:00.000Z"\n---\n\n# Second\nContent.',
      'utf-8'
    );

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('## All Files (chronological)');
    expect(content).toContain('| # | File | Directory | Description | Created | Size |');

    // Verify order: first.md should come before second.md in the chronological table
    const chronoSection = content.slice(content.indexOf('## All Files (chronological)'));
    const firstIdx = chronoSection.indexOf('first.md');
    const secondIdx = chronoSection.indexOf('second.md');
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  test('chronological section excludes archived files', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'keep.md'), '# Keep\nGood content here for the reader.', 'utf-8');
    mkdirSync(join(dir, 'archived'), { recursive: true });
    writeFileSync(join(dir, 'archived', 'old.md'), '# Old\nArchived content.', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    const chronoSection = content.slice(content.indexOf('## All Files (chronological)'));
    expect(chronoSection).toContain('keep.md');
    expect(chronoSection).not.toContain('old.md');
  });

  test('rebuildIndex uses changelog timestamp when no frontmatter', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(
      join(dir, 'tracked.md'),
      '# Tracked\nThis file has no frontmatter but has a changelog entry.',
      'utf-8'
    );

    // Log a production entry with a specific timestamp
    service.logProduction({
      timestamp: '2026-02-20T08:15:00.000Z',
      botId: 'testbot',
      tool: 'file_write',
      path: 'tracked.md',
      action: 'create',
      description: 'Tracked file',
      size: 50,
      trackOnly: false,
    });

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'INDEX.md'), 'utf-8');
    expect(content).toContain('2026-02-20 08:15');
  });
});

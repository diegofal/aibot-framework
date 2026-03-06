import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
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

describe('ProductionsService — rebuildIndex (HTML)', () => {
  let service: ProductionsService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new ProductionsService(makeConfig(), noopLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('generates index.html with correct title', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'hello.md'), '# Hello World\nSome content', 'utf-8');

    service.rebuildIndex('testbot');

    const indexPath = join(dir, 'index.html');
    expect(existsSync(indexPath)).toBe(true);

    const content = readFileSync(indexPath, 'utf-8');
    expect(content).toContain('<title>Productions');
    expect(content).toContain('testbot');
    expect(content).toContain('<!DOCTYPE html>');
  });

  test('lists files in the HTML output', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'report.md'), '# My Report\nDetails here', 'utf-8');
    writeFileSync(join(dir, 'notes.txt'), 'Some notes', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('report.md');
    expect(content).toContain('notes.txt');
  });

  test('handles subdirectories as collapsible groups', () => {
    const dir = service.resolveDir('testbot');
    mkdirSync(join(dir, 'research'), { recursive: true });
    writeFileSync(join(dir, 'research', 'findings.md'), '# Research Findings', 'utf-8');
    writeFileSync(join(dir, 'root_file.md'), '# Root File', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('research/');
    expect(content).toContain('findings.md');
    expect(content).toContain('root_file.md');
  });

  test('uses first heading as description for markdown files', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'doc.md'), '# Pipeline Tracker for Jobs\nContent here', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('Pipeline Tracker for Jobs');
  });

  test('uses changelog description when available', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'output.md'), '# Some heading\nContent', 'utf-8');

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

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('Custom description from changelog');
  });

  test('excludes index.html, INDEX.md, changelog.jsonl, summary.json from listing', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'real_file.md'), '# Real', 'utf-8');
    writeFileSync(join(dir, 'INDEX.md'), 'old index', 'utf-8');
    writeFileSync(join(dir, 'changelog.jsonl'), '{}', 'utf-8');
    writeFileSync(join(dir, 'summary.json'), '{}', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('real_file.md');
    expect(content).not.toContain('href="INDEX.md"');
    expect(content).not.toContain('href="changelog.jsonl"');
    expect(content).not.toContain('href="summary.json"');
  });

  test('handles empty directory with meaningful empty state', () => {
    service.resolveDir('testbot');

    service.rebuildIndex('testbot');

    const dir = service.resolveDir('testbot');
    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('No productions yet');
    expect(content).toContain("hasn't created any production files yet");
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

    const indexPath = join(dir, 'index.html');
    expect(existsSync(indexPath)).toBe(true);
    const content = readFileSync(indexPath, 'utf-8');
    expect(content).toContain('pre_existing.md');
  });

  test('includes stats section with file count', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'tiny.md'), 'x', 'utf-8');
    writeFileSync(join(dir, 'medium.md'), 'x'.repeat(2048), 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('<div class="number">2</div>');
    expect(content).toContain('Files');
  });

  test('skips generic file_write descriptions from changelog', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'report.md'), '# My Report Title\nContent', 'utf-8');

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

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('My Report Title');
  });

  test('generated HTML is a valid self-contained page', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'file.md'), '# File\nContent', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('<!DOCTYPE html>');
    expect(content).toContain('</html>');
    expect(content).toContain('<style>');
    expect(content).toContain('class="content"');
  });

  test('file links point to dashboard route, not href="#"', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'report.md'), '# Report\nContent', 'utf-8');
    writeFileSync(join(dir, 'analysis.txt'), 'Some analysis', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('href="/#/productions?bot=testbot&amp;file=report.md"');
    expect(content).toContain('href="/#/productions?bot=testbot&amp;file=analysis.txt"');
    expect(content).not.toContain('href="#"');
    expect(content).not.toContain('data-path=');
  });

  test('shows archived file count in stats', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'keep.md'), '# Keep\nGood content here for the reader.', 'utf-8');
    mkdirSync(join(dir, 'archived'), { recursive: true });
    writeFileSync(join(dir, 'archived', 'old.md'), '# Old\nArchived content.', 'utf-8');

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('keep.md');
    expect(content).toContain('Archived');
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

  test('rebuilds index.html after archiving', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'to_archive.md'), '# To Archive', 'utf-8');
    writeFileSync(join(dir, 'keep.md'), '# Keep', 'utf-8');

    service.archiveFile('testbot', 'to_archive.md', 'Test reason');

    const indexContent = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(indexContent).toContain('Archived');
    expect(indexContent).toContain('keep.md');
    expect(indexContent).not.toContain('href="to_archive.md"');
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

describe('ProductionsService — readActiveGoals', () => {
  let service: ProductionsService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new ProductionsService(makeConfig(), noopLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('returns empty array when no GOALS.md exists', () => {
    const goals = service.readActiveGoals('nonexistent-bot');
    expect(goals).toEqual([]);
  });

  test('parses active goals from GOALS.md', () => {
    const soulDir = join(process.cwd(), 'config/soul/testbot');
    mkdirSync(soulDir, { recursive: true });
    writeFileSync(
      join(soulDir, 'GOALS.md'),
      `## Active Goals
- [ ] Build production pipeline
  - status: in_progress
  - priority: high
  - notes: Working on it
- [ ] Write documentation
  - status: pending
  - priority: medium

## Completed
- [x] Setup project
  - completed: 2026-03-01
`,
      'utf-8'
    );

    try {
      const goals = service.readActiveGoals('testbot');
      expect(goals).toHaveLength(2);
      expect(goals[0].text).toBe('Build production pipeline');
      expect(goals[0].status).toBe('in_progress');
      expect(goals[0].priority).toBe('high');
      expect(goals[0].notes).toBe('Working on it');
      expect(goals[1].text).toBe('Write documentation');
      expect(goals[1].status).toBe('pending');
      expect(goals[1].priority).toBe('medium');
    } finally {
      rmSync(join(soulDir, 'GOALS.md'));
      try {
        rmSync(soulDir, { recursive: true });
      } catch {}
    }
  });

  test('falls back to first section for non-standard GOALS.md format', () => {
    const soulDir = join(process.cwd(), 'config/soul/testbot');
    mkdirSync(soulDir, { recursive: true });
    writeFileSync(
      join(soulDir, 'GOALS.md'),
      `## Metas a Corto Plazo (0-3 meses)
- **Validación de los primeros USD 100**: Generar la primera venta real.
- **Auditoría de tiempo**: Registrar dónde va cada hora de tu semana.
- **Lanzamiento del MVP**: Tener algo cobrable en el mercado.

## Metas a Mediano Plazo (3-12 meses)
- **Reemplazo de ingresos**: Igualar tu sueldo actual.
`,
      'utf-8'
    );

    try {
      const goals = service.readActiveGoals('testbot');
      expect(goals).toHaveLength(3);
      expect(goals[0].text).toContain('Validación de los primeros USD 100');
      expect(goals[0].text).toContain('Generar la primera venta real.');
      expect(goals[0].status).toBe('pending');
      expect(goals[1].text).toContain('Auditoría de tiempo');
      expect(goals[2].text).toContain('Lanzamiento del MVP');
    } finally {
      rmSync(join(soulDir, 'GOALS.md'));
      try {
        rmSync(soulDir, { recursive: true });
      } catch {}
    }
  });

  test('falls back to plain bullet list when no checkboxes or bold items', () => {
    const soulDir = join(process.cwd(), 'config/soul/testbot');
    mkdirSync(soulDir, { recursive: true });
    writeFileSync(
      join(soulDir, 'GOALS.md'),
      `## Objetivos Actuales
- Completar el primer prototipo
- Conseguir 3 usuarios beta

## Completados
- Setup del proyecto
`,
      'utf-8'
    );

    try {
      const goals = service.readActiveGoals('testbot');
      expect(goals).toHaveLength(2);
      expect(goals[0].text).toBe('Completar el primer prototipo');
      expect(goals[1].text).toBe('Conseguir 3 usuarios beta');
    } finally {
      rmSync(join(soulDir, 'GOALS.md'));
      try {
        rmSync(soulDir, { recursive: true });
      } catch {}
    }
  });

  test('prefers standard parseGoals over fallback when Active Goals section exists', () => {
    const soulDir = join(process.cwd(), 'config/soul/testbot');
    mkdirSync(soulDir, { recursive: true });
    writeFileSync(
      join(soulDir, 'GOALS.md'),
      `## Active Goals
- [ ] Standard goal
  - status: in_progress
  - priority: high

## Other Section
- **Bold item**: description
`,
      'utf-8'
    );

    try {
      const goals = service.readActiveGoals('testbot');
      expect(goals).toHaveLength(1);
      expect(goals[0].text).toBe('Standard goal');
      expect(goals[0].status).toBe('in_progress');
    } finally {
      rmSync(join(soulDir, 'GOALS.md'));
      try {
        rmSync(soulDir, { recursive: true });
      } catch {}
    }
  });

  test('goals appear in generated index.html', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(join(dir, 'file.md'), '# File\nContent', 'utf-8');

    const soulDir = join(process.cwd(), 'config/soul/testbot');
    mkdirSync(soulDir, { recursive: true });
    writeFileSync(
      join(soulDir, 'GOALS.md'),
      `## Active Goals
- [ ] Important task
  - status: in_progress
  - priority: high
`,
      'utf-8'
    );

    try {
      service.rebuildIndex('testbot');

      const content = readFileSync(join(dir, 'index.html'), 'utf-8');
      expect(content).toContain('Active Goals');
      expect(content).toContain('Important task');
      expect(content).toContain('in_progress');
    } finally {
      rmSync(join(soulDir, 'GOALS.md'));
      try {
        rmSync(soulDir, { recursive: true });
      } catch {}
    }
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

  test('rebuildIndex shows datetime', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(
      join(dir, 'report.md'),
      '---\ncreated_at: "2026-03-03T14:23:00.000Z"\n---\n\n# Report\nContent here.',
      'utf-8'
    );

    service.rebuildIndex('testbot');

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
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

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('2025-01-15 09:30');
  });

  test('rebuildIndex uses changelog timestamp when no frontmatter', () => {
    const dir = service.resolveDir('testbot');
    writeFileSync(
      join(dir, 'tracked.md'),
      '# Tracked\nThis file has no frontmatter but has a changelog entry.',
      'utf-8'
    );

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

    const content = readFileSync(join(dir, 'index.html'), 'utf-8');
    expect(content).toContain('2026-02-20 08:15');
  });
});

describe('Path normalization — workDir prefix stripping and subdir guard', () => {
  /**
   * These tests exercise the same logic used in tool-executor.ts
   * to normalize LLM-supplied file paths before resolve().
   */
  function normalizeFilePath(workDir: string, rawPath: string): string {
    let filePath = rawPath;
    const normWork = workDir.replace(/^\.\//, '');
    const normFile = filePath.replace(/^\.\//, '');
    if (normWork && normFile.startsWith(`${normWork}/`)) {
      filePath = normFile.slice(normWork.length + 1);
    }
    return resolve(workDir, filePath);
  }

  function guardSubdir(workDir: string, resolved: string): string {
    const absWork = resolve(workDir);
    const rel = relative(absWork, resolved);
    if (rel.includes('/') && !rel.startsWith('archived/') && !rel.startsWith('..')) {
      return join(absWork, basename(resolved));
    }
    return resolved;
  }

  test('strips redundant workDir prefix from path', () => {
    const result = normalizeFilePath(
      './productions/job-seeker',
      'productions/job-seeker/report.md'
    );
    expect(result).toBe(resolve('./productions/job-seeker', 'report.md'));
  });

  test('strips prefix with ./ on both sides', () => {
    const result = normalizeFilePath('./productions/bot1', './productions/bot1/file.txt');
    expect(result).toBe(resolve('./productions/bot1', 'file.txt'));
  });

  test('leaves plain relative path untouched', () => {
    const result = normalizeFilePath('./productions/bot1', 'my_report.md');
    expect(result).toBe(resolve('./productions/bot1', 'my_report.md'));
  });

  test('subdir guard flattens nested subdir to root', () => {
    const workDir = './productions/bot1';
    const nested = resolve(workDir, 'subdir/file.md');
    const result = guardSubdir(workDir, nested);
    expect(result).toBe(join(resolve(workDir), 'file.md'));
  });

  test('subdir guard allows archived/ subdirectory', () => {
    const workDir = './productions/bot1';
    const archived = resolve(workDir, 'archived/old.md');
    const result = guardSubdir(workDir, archived);
    expect(result).toBe(archived);
  });

  test('subdir guard leaves root-level files untouched', () => {
    const workDir = './productions/bot1';
    const rootFile = resolve(workDir, 'report.md');
    const result = guardSubdir(workDir, rootFile);
    expect(result).toBe(rootFile);
  });

  test('combined: redundant prefix + subdir guard yields correct root file', () => {
    const workDir = './productions/job-seeker';
    const normalized = normalizeFilePath(workDir, 'productions/job-seeker/report.md');
    const guarded = guardSubdir(workDir, normalized);
    expect(guarded).toBe(resolve(workDir, 'report.md'));
  });
});

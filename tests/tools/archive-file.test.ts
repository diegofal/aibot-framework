import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchiveFileTool } from '../../src/tools/archive-file';
import { ProductionsService } from '../../src/productions/service';
import type { Config } from '../../src/config';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

const TEST_DIR = join(process.cwd(), '.test-archive-tool');

function makeConfig(): Config {
  return {
    bots: [
      {
        id: 'archivebot',
        name: 'Archive Bot',
        token: '',
        enabled: true,
        skills: [],
        productions: { enabled: true, trackOnly: false },
      },
      {
        id: 'disabled',
        name: 'Disabled Bot',
        token: '',
        enabled: true,
        skills: [],
        productions: { enabled: false },
      },
    ],
    productions: {
      enabled: true,
      baseDir: TEST_DIR,
    },
  } as Config;
}

describe('archive_file tool', () => {
  let service: ProductionsService;
  let tool: ReturnType<typeof createArchiveFileTool>;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new ProductionsService(makeConfig(), noopLogger);
    tool = createArchiveFileTool(service);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('has correct definition', () => {
    expect(tool.definition.function.name).toBe('archive_file');
    expect(tool.definition.function.parameters.required).toContain('path');
    expect(tool.definition.function.parameters.required).toContain('reason');
  });

  test('archives a file successfully', async () => {
    const dir = service.resolveDir('archivebot');
    writeFileSync(join(dir, 'old_report.md'), '# Old Report', 'utf-8');

    const result = await tool.execute(
      { _botId: 'archivebot', path: 'old_report.md', reason: 'Superseded by new_report.md' },
      noopLogger,
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Archived');
    expect(result.content).toContain('old_report.md');
    expect(existsSync(join(dir, 'archived', 'old_report.md'))).toBe(true);
    expect(existsSync(join(dir, 'old_report.md'))).toBe(false);
  });

  test('fails without _botId', async () => {
    const result = await tool.execute(
      { path: 'file.md', reason: 'test' },
      noopLogger,
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('_botId');
  });

  test('fails when productions disabled', async () => {
    const result = await tool.execute(
      { _botId: 'disabled', path: 'file.md', reason: 'test' },
      noopLogger,
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('not enabled');
  });

  test('fails without path or reason', async () => {
    const result = await tool.execute(
      { _botId: 'archivebot' },
      noopLogger,
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('required');
  });

  test('fails for non-existent file', async () => {
    service.resolveDir('archivebot');
    const result = await tool.execute(
      { _botId: 'archivebot', path: 'nonexistent.md', reason: 'test' },
      noopLogger,
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('not found');
  });

  test('includes reason in success message', async () => {
    const dir = service.resolveDir('archivebot');
    writeFileSync(join(dir, 'draft.md'), 'content', 'utf-8');

    const result = await tool.execute(
      { _botId: 'archivebot', path: 'draft.md', reason: 'Replaced by final version' },
      noopLogger,
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Replaced by final version');
  });
});

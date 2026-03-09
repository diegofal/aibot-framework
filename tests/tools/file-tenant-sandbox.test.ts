import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFileEditTool, createFileReadTool, createFileWriteTool } from '../../src/tools/file';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-file-tenant-sandbox');
const TENANT_ROOT = join(TEST_DIR, 'data', 'tenants', 'tenant-A');
const BOT_WORK_DIR = join(TENANT_ROOT, 'bots', 'bot1', 'productions');
const OTHER_DIR = join(TEST_DIR, 'data', 'tenants', 'tenant-B', 'bots', 'bot2', 'productions');

describe('File tools tenant sandboxing', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(BOT_WORK_DIR, { recursive: true });
    mkdirSync(OTHER_DIR, { recursive: true });
    writeFileSync(join(BOT_WORK_DIR, 'notes.txt'), 'hello world');
    writeFileSync(join(OTHER_DIR, 'secret.txt'), 'other tenant data');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('file_read', () => {
    it('allows reading within tenant root', async () => {
      const tool = createFileReadTool({ basePath: BOT_WORK_DIR });
      const result = await tool.execute(
        { path: 'notes.txt', _tenantRoot: TENANT_ROOT },
        noopLogger
      );
      expect(result.success).toBe(true);
      expect(result.content).toContain('hello world');
    });

    it('blocks reading outside tenant root', async () => {
      const tool = createFileReadTool({ basePath: TEST_DIR });
      const result = await tool.execute(
        {
          path: join('data', 'tenants', 'tenant-B', 'bots', 'bot2', 'productions', 'secret.txt'),
          _tenantRoot: TENANT_ROOT,
        },
        noopLogger
      );
      expect(result.success).toBe(false);
      expect(result.content).toContain('tenant boundary');
    });

    it('allows reading when no tenantRoot (single-tenant)', async () => {
      const tool = createFileReadTool({ basePath: BOT_WORK_DIR });
      const result = await tool.execute({ path: 'notes.txt' }, noopLogger);
      expect(result.success).toBe(true);
    });
  });

  describe('file_write', () => {
    it('blocks writing outside tenant root', async () => {
      const tool = createFileWriteTool({ basePath: TEST_DIR });
      const result = await tool.execute(
        {
          path: join('data', 'tenants', 'tenant-B', 'bots', 'bot2', 'productions', 'hack.txt'),
          content: 'pwned',
          _tenantRoot: TENANT_ROOT,
        },
        noopLogger
      );
      expect(result.success).toBe(false);
      expect(result.content).toContain('tenant boundary');
    });

    it('allows writing within tenant root', async () => {
      const tool = createFileWriteTool({ basePath: BOT_WORK_DIR });
      const result = await tool.execute(
        { path: 'new-file.txt', content: 'hello', _tenantRoot: TENANT_ROOT },
        noopLogger
      );
      expect(result.success).toBe(true);
    });
  });

  describe('file_edit', () => {
    it('blocks editing outside tenant root', async () => {
      const tool = createFileEditTool({ basePath: TEST_DIR });
      const result = await tool.execute(
        {
          path: join('data', 'tenants', 'tenant-B', 'bots', 'bot2', 'productions', 'secret.txt'),
          old_text: 'other',
          new_text: 'hacked',
          _tenantRoot: TENANT_ROOT,
        },
        noopLogger
      );
      expect(result.success).toBe(false);
      expect(result.content).toContain('tenant boundary');
    });
  });
});

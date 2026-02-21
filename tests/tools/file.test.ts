import { describe, test, expect, beforeAll } from 'bun:test';
import { createFileReadTool, createFileWriteTool, createFileEditTool } from '../../src/tools/file';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function createMockLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createMockLogger(),
    fatal: () => {},
    trace: () => {},
    level: 'info',
    silent: () => {},
  } as any;
}

const logger = createMockLogger();
const TEST_DIR = '/tmp/aibot-test-files';

// Setup test directory
function setupTestDir() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, 'hello.txt'), 'Hello World\nLine 2\nLine 3\n');
  writeFileSync(join(TEST_DIR, 'data.json'), '{"key": "value"}');
}

describe('file_read tool', () => {
  const tool = createFileReadTool({ basePath: TEST_DIR });

  test('has correct definition', () => {
    expect(tool.definition.function.name).toBe('file_read');
  });

  describe('path validation', () => {
    test('blocks path traversal', async () => {
      setupTestDir();
      const result = await tool.execute({ path: '../../../etc/passwd' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('outside allowed directory');
    });

    test('blocks .env files', async () => {
      setupTestDir();
      writeFileSync(join(TEST_DIR, '.env'), 'SECRET=123');
      const result = await tool.execute({ path: '.env' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked pattern');
    });

    test('blocks .env.local files', async () => {
      setupTestDir();
      const result = await tool.execute({ path: '.env.local' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked pattern');
    });

    test('blocks credentials files', async () => {
      setupTestDir();
      const result = await tool.execute({ path: 'credentials.json' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked pattern');
    });

    test('blocks .key files', async () => {
      setupTestDir();
      const result = await tool.execute({ path: 'server.key' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked pattern');
    });

    test('blocks .pem files', async () => {
      setupTestDir();
      const result = await tool.execute({ path: 'cert.pem' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked pattern');
    });

    test('blocks .ssh directory', async () => {
      setupTestDir();
      const result = await tool.execute({ path: '.ssh/id_rsa' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked pattern');
    });

    test('blocks token.json', async () => {
      setupTestDir();
      const result = await tool.execute({ path: 'token.json' }, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('blocked pattern');
    });
  });

  describe('reading files', () => {
    test('reads existing file', async () => {
      setupTestDir();
      const result = await tool.execute({ path: 'hello.txt' }, logger);
      expect(result.success).toBe(true);
      expect(result.content).toContain('Hello World');
    });

    test('returns error for non-existent file', async () => {
      setupTestDir();
      const result = await tool.execute({ path: 'nope.txt' }, logger);
      expect(result.success).toBe(false);
    });

    test('reads with offset and limit', async () => {
      setupTestDir();
      const result = await tool.execute({ path: 'hello.txt', offset: 2, limit: 1 }, logger);
      expect(result.success).toBe(true);
      expect(result.content).toContain('Line 2');
      expect(result.content).not.toContain('Hello World');
    });

    test('rejects missing path parameter', async () => {
      const result = await tool.execute({}, logger);
      expect(result.success).toBe(false);
      expect(result.content).toContain('Missing');
    });
  });
});

describe('file_write tool', () => {
  const tool = createFileWriteTool({ basePath: TEST_DIR });

  test('has correct definition', () => {
    expect(tool.definition.function.name).toBe('file_write');
  });

  test('creates new file', async () => {
    setupTestDir();
    const result = await tool.execute({ path: 'new.txt', content: 'fresh content' }, logger);
    expect(result.success).toBe(true);

    const readTool = createFileReadTool({ basePath: TEST_DIR });
    const read = await readTool.execute({ path: 'new.txt' }, logger);
    expect(read.content).toContain('fresh content');
  });

  test('creates intermediate directories', async () => {
    setupTestDir();
    const result = await tool.execute({ path: 'sub/dir/file.txt', content: 'nested' }, logger);
    expect(result.success).toBe(true);
  });

  test('appends when append=true', async () => {
    setupTestDir();
    await tool.execute({ path: 'append.txt', content: 'first' }, logger);
    await tool.execute({ path: 'append.txt', content: ' second', append: true }, logger);

    const readTool = createFileReadTool({ basePath: TEST_DIR });
    const read = await readTool.execute({ path: 'append.txt' }, logger);
    expect(read.content).toContain('first second');
  });

  test('blocks path traversal on write', async () => {
    setupTestDir();
    const result = await tool.execute(
      { path: '../../etc/crontab', content: 'evil' },
      logger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('outside allowed directory');
  });

  test('blocks writing to sensitive paths', async () => {
    setupTestDir();
    const result = await tool.execute({ path: '.env', content: 'SECRET=hack' }, logger);
    expect(result.success).toBe(false);
  });
});

describe('file_edit tool', () => {
  const tool = createFileEditTool({ basePath: TEST_DIR });

  test('has correct definition', () => {
    expect(tool.definition.function.name).toBe('file_edit');
  });

  test('replaces exact text', async () => {
    setupTestDir();
    const result = await tool.execute(
      { path: 'hello.txt', old_text: 'Hello World', new_text: 'Goodbye World' },
      logger
    );
    expect(result.success).toBe(true);

    const readTool = createFileReadTool({ basePath: TEST_DIR });
    const read = await readTool.execute({ path: 'hello.txt' }, logger);
    expect(read.content).toContain('Goodbye World');
    expect(read.content).not.toContain('Hello World');
  });

  test('fails when old_text not found', async () => {
    setupTestDir();
    const result = await tool.execute(
      { path: 'hello.txt', old_text: 'NONEXISTENT', new_text: 'replacement' },
      logger
    );
    expect(result.success).toBe(false);
  });

  test('blocks editing sensitive files', async () => {
    setupTestDir();
    const result = await tool.execute(
      { path: '.env', old_text: 'x', new_text: 'y' },
      logger
    );
    expect(result.success).toBe(false);
  });
});

// ─── allowedPaths ──────────────────────────────────────────

const ALLOWED_DIR = '/tmp/aibot-test-allowed';

describe('allowedPaths', () => {
  beforeAll(() => {
    setupTestDir();
    rmSync(ALLOWED_DIR, { recursive: true, force: true });
    mkdirSync(ALLOWED_DIR, { recursive: true });
    writeFileSync(join(ALLOWED_DIR, 'ref.txt'), 'reference content\n');
    writeFileSync(join(ALLOWED_DIR, '.env'), 'SECRET=leak');
  });

  test('file_read succeeds for absolute paths in an allowed directory', async () => {
    const tool = createFileReadTool({ basePath: TEST_DIR, allowedPaths: [ALLOWED_DIR] });
    const result = await tool.execute({ path: join(ALLOWED_DIR, 'ref.txt') }, logger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('reference content');
  });

  test('file_read fails for absolute paths outside basePath and allowedPaths', async () => {
    const tool = createFileReadTool({ basePath: TEST_DIR, allowedPaths: [ALLOWED_DIR] });
    const result = await tool.execute({ path: '/etc/hostname' }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('outside allowed directory');
  });

  test('path traversal out of an allowed directory is blocked', async () => {
    const tool = createFileReadTool({ basePath: TEST_DIR, allowedPaths: [ALLOWED_DIR] });
    // Absolute path that tries to escape the allowed dir
    const result = await tool.execute({ path: join(ALLOWED_DIR, '../etc/passwd') }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('outside allowed directory');
  });

  test('file_write to an allowed (non-base) directory is blocked', async () => {
    const writeTool = createFileWriteTool({ basePath: TEST_DIR });
    const result = await writeTool.execute(
      { path: join(ALLOWED_DIR, 'hack.txt'), content: 'evil' },
      logger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('outside allowed directory');
  });

  test('file_edit to an allowed (non-base) directory is blocked', async () => {
    const editTool = createFileEditTool({ basePath: TEST_DIR });
    const result = await editTool.execute(
      { path: join(ALLOWED_DIR, 'ref.txt'), old_text: 'reference', new_text: 'hacked' },
      logger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('outside allowed directory');
  });

  test('denied patterns still apply within allowed paths', async () => {
    const tool = createFileReadTool({ basePath: TEST_DIR, allowedPaths: [ALLOWED_DIR] });
    const result = await tool.execute({ path: join(ALLOWED_DIR, '.env') }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('blocked pattern');
  });
});

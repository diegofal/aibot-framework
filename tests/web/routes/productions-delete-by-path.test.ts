import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { ProductionsService } from '../../../src/productions/service';
import { productionsRoutes } from '../../../src/web/routes/productions';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(import.meta.dir, '../../.tmp-prod-delete-test');

function makeConfig(baseDir: string): Config {
  return {
    bots: [{ id: 'bot1', name: 'TestBot' }],
    productions: { enabled: true, baseDir },
    improve: { claudePath: 'claude', timeout: 30_000 },
  } as unknown as Config;
}

describe('POST /api/productions/:botId/delete-by-path', () => {
  let app: Hono;
  let botDir: string;
  let service: ProductionsService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const config = makeConfig(TEST_DIR);
    service = new ProductionsService(config, noopLogger);

    // Create bot dir structure
    botDir = join(TEST_DIR, 'bot1');
    mkdirSync(botDir, { recursive: true });
    mkdirSync(join(botDir, 'subdir'), { recursive: true });
    writeFileSync(join(botDir, 'file1.md'), '# File 1');
    writeFileSync(join(botDir, 'subdir', 'file2.md'), '# File 2');
    writeFileSync(join(botDir, 'subdir', 'file3.md'), '# File 3');

    // Write a changelog entry referencing file1.md
    const entry = {
      id: 'e1',
      timestamp: new Date().toISOString(),
      botId: 'bot1',
      tool: 'file_write',
      path: 'file1.md',
      action: 'create',
      description: 'Created file1',
      size: 8,
    };
    const subdirEntry = {
      id: 'e2',
      timestamp: new Date().toISOString(),
      botId: 'bot1',
      tool: 'file_write',
      path: 'subdir/file2.md',
      action: 'create',
      description: 'Created file2',
      size: 8,
    };
    writeFileSync(
      join(botDir, 'changelog.jsonl'),
      `${JSON.stringify(entry)}\n${JSON.stringify(subdirEntry)}\n`
    );

    const mockBotManager = {
      getSoulLoader: () => undefined,
      findSoulLoader: () => undefined,
      getKarmaService: () => undefined,
      getActivityStream: () => undefined,
      soulLoaders: new Map(),
    } as any;

    const routes = productionsRoutes({
      productionsService: service,
      botManager: mockBotManager,
      logger: noopLogger,
      config,
    });

    app = new Hono();
    app.route('/api/productions', routes);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('delete file by path removes file and changelog entry', async () => {
    const res = await app.request('/api/productions/bot1/delete-by-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'file1.md' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deletedFiles).toBe(1);
    expect(data.deletedEntries).toBe(1);
    expect(existsSync(join(botDir, 'file1.md'))).toBe(false);
  });

  test('delete file without changelog entry still removes file', async () => {
    writeFileSync(join(botDir, 'untracked.md'), '# Untracked');
    const res = await app.request('/api/productions/bot1/delete-by-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'untracked.md' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deletedFiles).toBe(1);
    expect(data.deletedEntries).toBe(0);
    expect(existsSync(join(botDir, 'untracked.md'))).toBe(false);
  });

  test('delete folder recursively removes files and changelog entries', async () => {
    const res = await app.request('/api/productions/bot1/delete-by-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'subdir' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deletedFiles).toBe(2);
    expect(data.deletedEntries).toBe(1); // only file2.md had a changelog entry with subdir/ prefix
    expect(existsSync(join(botDir, 'subdir'))).toBe(false);
  });

  test('path traversal is blocked', async () => {
    const res = await app.request('/api/productions/bot1/delete-by-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../../../etc/passwd' }),
    });

    expect(res.status).toBe(404);
  });

  test('absolute path is blocked', async () => {
    const res = await app.request('/api/productions/bot1/delete-by-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd' }),
    });

    expect(res.status).toBe(404);
  });

  test('non-existent bot returns 404', async () => {
    const res = await app.request('/api/productions/nonexistent/delete-by-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'file1.md' }),
    });

    expect(res.status).toBe(404);
  });

  test('non-existent file returns 404', async () => {
    const res = await app.request('/api/productions/bot1/delete-by-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'nope.md' }),
    });

    expect(res.status).toBe(404);
  });

  test('missing path in body returns 400', async () => {
    const res = await app.request('/api/productions/bot1/delete-by-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

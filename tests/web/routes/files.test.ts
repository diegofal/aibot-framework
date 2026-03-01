import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { filesRoutes } from '../../../src/web/routes/files';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(process.cwd(), '.test-files-routes');
const BOT_WORK_DIR = join(TEST_DIR, 'bot1');

const mockConfig = {
  bots: [{ id: 'bot1', name: 'TestBot', workDir: BOT_WORK_DIR }],
  ollama: { models: { primary: 'test' } },
  soul: { dir: join(TEST_DIR, 'soul') },
  productions: { baseDir: TEST_DIR },
  conversation: { systemPrompt: '', temperature: 0.7, maxHistory: 10 },
} as unknown as Config;

function makeApp() {
  const app = new Hono();
  app.route('/api/files', filesRoutes({ config: mockConfig, logger: noopLogger }));
  return app;
}

describe('files routes', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(BOT_WORK_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('returns file content for valid path', async () => {
    writeFileSync(join(BOT_WORK_DIR, 'hello.txt'), 'Hello World');

    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/hello.txt');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.path).toBe('hello.txt');
    expect(data.content).toBe('Hello World');
    expect(data.size).toBe(11);
  });

  test('returns file in subdirectory', async () => {
    mkdirSync(join(BOT_WORK_DIR, 'sub'), { recursive: true });
    writeFileSync(join(BOT_WORK_DIR, 'sub', 'data.md'), '# Title');

    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/sub/data.md');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.path).toBe('sub/data.md');
    expect(data.content).toBe('# Title');
  });

  test('rejects path traversal', async () => {
    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(403);

    const data = await res.json();
    expect(data.error).toContain('outside allowed directory');
  });

  test('rejects .env files', async () => {
    writeFileSync(join(BOT_WORK_DIR, '.env'), 'SECRET=123');

    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/.env');
    expect(res.status).toBe(403);

    const data = await res.json();
    expect(data.error).toContain('blocked pattern');
  });

  test('rejects credentials file', async () => {
    writeFileSync(join(BOT_WORK_DIR, 'credentials.json'), '{}');

    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/credentials.json');
    expect(res.status).toBe(403);
  });

  test('rejects .key files', async () => {
    writeFileSync(join(BOT_WORK_DIR, 'server.key'), 'private');

    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/server.key');
    expect(res.status).toBe(403);
  });

  test('rejects .pem files', async () => {
    writeFileSync(join(BOT_WORK_DIR, 'cert.pem'), 'cert');

    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/cert.pem');
    expect(res.status).toBe(403);
  });

  test('returns 404 for non-existent file', async () => {
    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/nofile.txt');
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.error).toBe('File not found');
  });

  test('returns 404 for unknown bot', async () => {
    const app = makeApp();
    const res = await app.request('http://localhost/api/files/unknown-bot/file.txt');
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.error).toBe('Bot not found');
  });

  test('returns 400 for missing path', async () => {
    const app = makeApp();
    // Trailing slash only — no path
    const res = await app.request('http://localhost/api/files/bot1/');
    // Hono may return 404 for empty wildcard, which is also acceptable
    expect([400, 404]).toContain(res.status);
  });

  test('rejects symlink escaping workDir', async () => {
    // Create a file outside workDir
    const outsideDir = join(TEST_DIR, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret data');

    // Create symlink inside workDir pointing outside
    try {
      symlinkSync(join(outsideDir, 'secret.txt'), join(BOT_WORK_DIR, 'escape.txt'));
    } catch {
      // Symlink creation may fail in some environments — skip test
      return;
    }

    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/escape.txt');
    expect(res.status).toBe(403);

    const data = await res.json();
    expect(data.error).toContain('Symlink');
  });

  test('rejects .secret files', async () => {
    writeFileSync(join(BOT_WORK_DIR, '.secret'), 'hidden');

    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/.secret');
    expect(res.status).toBe(403);
  });

  test('rejects token.json', async () => {
    writeFileSync(join(BOT_WORK_DIR, 'token.json'), '{}');

    const app = makeApp();
    const res = await app.request('http://localhost/api/files/bot1/token.json');
    expect(res.status).toBe(403);
  });
});

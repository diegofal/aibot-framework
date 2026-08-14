import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  buildEffectiveConfig,
  readRawBots,
  readRawConfig,
} from '../../../src/system/effective-config';
import { unpackTarGz } from '../../../src/system/tar-archive';
import { systemExportRoutes } from '../../../src/web/routes/system-export';

const TEST_DIR = join(import.meta.dir, '..', '..', '..', '.test-system-routes');
const CONFIG_PATH = join(TEST_DIR, 'config', 'config.json');
const BOTS_PATH = join(TEST_DIR, 'config', 'bots.json');

const FAKE_TOKEN = '333333333:AAHfakeRouteTokenABCDEFGHIJKLMNOPQR';
const FAKE_BRAVE = 'BSAfakeRouteBraveKey123456';

function createMockLogger() {
  const logger: any = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: () => logger,
  };
  return logger;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    config: buildEffectiveConfig(readRawConfig(CONFIG_PATH), readRawBots(CONFIG_PATH), TEST_DIR),
    configPath: CONFIG_PATH,
    botManager: { isRunning: () => false } as any,
    logger: createMockLogger(),
    rootDir: TEST_DIR,
    ...overrides,
  };
}

function createApp(deps = makeDeps(), tenantId?: string) {
  const app = new Hono();
  if (tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'free' });
      await next();
    });
  }
  app.route('/api/system', systemExportRoutes(deps as any));
  return app;
}

describe('systemExportRoutes', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, 'config'), { recursive: true });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        ollama: { baseUrl: 'http://127.0.0.1:11434', models: { primary: 'm' } },
        webTools: { search: { apiKey: FAKE_BRAVE } },
        soul: { dir: './config/soul' },
      }),
      'utf-8'
    );
    writeFileSync(
      BOTS_PATH,
      JSON.stringify([
        { id: 'bot-a', name: 'Bot A', token: FAKE_TOKEN, enabled: true, skills: [] },
      ]),
      'utf-8'
    );
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    // Assigning `undefined` to an env var stores the string "undefined", so
    // these have to be deleted rather than blanked.
    // biome-ignore lint/performance/noDelete: the variable must be absent
    delete process.env.AIBOT_SYSTEM_EXPORT_REQUIRE_ADMIN_KEY;
    // biome-ignore lint/performance/noDelete: the variable must be absent
    delete process.env.ADMIN_API_KEY;
  });

  describe('GET /export', () => {
    it('returns a gzip attachment', async () => {
      const res = await createApp().request('/api/system/export');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/gzip');
      expect(res.headers.get('content-disposition')).toContain('aibot-system-export-');

      const buffer = Buffer.from(await res.arrayBuffer());
      const { files } = unpackTarGz(buffer);
      expect(files.has('manifest.json')).toBe(true);
      expect(files.has('REQUIRED_ENV.txt')).toBe(true);
    });

    it('never includes a secret in the downloaded bundle', async () => {
      const res = await createApp().request('/api/system/export');
      const { files } = unpackTarGz(Buffer.from(await res.arrayBuffer()));
      const text = [...files.values()].map((data) => data.toString('utf-8')).join('\n');

      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain(FAKE_BRAVE);
      expect(text).toContain('${BRAVE_SEARCH_API_KEY}');
    });

    it('honours the sections parameter', async () => {
      const res = await createApp().request('/api/system/export?sections=config');
      const { files } = unpackTarGz(Buffer.from(await res.arrayBuffer()));

      expect(res.headers.get('x-export-sections')).toBe('config');
      expect(files.has('config/bots.json')).toBe(false);
    });

    it('rejects an unknown section', async () => {
      const res = await createApp().request('/api/system/export?sections=nonsense');
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('Unknown section');
    });

    it('returns the manifest without the payload', async () => {
      const res = await createApp().request('/api/system/export/manifest');
      const manifest = await res.json();

      expect(res.status).toBe(200);
      expect(manifest.kind).toBe('aibot-system-export');
      expect(manifest.inventory.agents).toHaveLength(1);
    });

    it('is forbidden for a non-admin tenant', async () => {
      const res = await createApp(makeDeps(), 'tenant-1').request('/api/system/export');
      expect(res.status).toBe(403);
    });

    it('is allowed for the admin tenant', async () => {
      const res = await createApp(makeDeps(), '__admin__').request('/api/system/export');
      expect(res.status).toBe(200);
    });
  });

  describe('admin key enforcement', () => {
    it('is off by default so the local no-auth workflow keeps working', async () => {
      process.env.ADMIN_API_KEY = 'super-secret-admin-key';
      const res = await createApp().request('/api/system/export');
      expect(res.status).toBe(200);
    });

    it('rejects an unauthenticated request when enforcement is enabled', async () => {
      process.env.AIBOT_SYSTEM_EXPORT_REQUIRE_ADMIN_KEY = 'true';
      process.env.ADMIN_API_KEY = 'super-secret-admin-key';

      const res = await createApp().request('/api/system/export');
      expect(res.status).toBe(401);
    });

    it('accepts the admin key as a bearer token or X-Admin-Key header', async () => {
      process.env.AIBOT_SYSTEM_EXPORT_REQUIRE_ADMIN_KEY = 'true';
      process.env.ADMIN_API_KEY = 'super-secret-admin-key';

      const bearer = await createApp().request('/api/system/export', {
        headers: { authorization: 'Bearer super-secret-admin-key' },
      });
      expect(bearer.status).toBe(200);

      const header = await createApp().request('/api/system/export', {
        headers: { 'x-admin-key': 'super-secret-admin-key' },
      });
      expect(header.status).toBe(200);
    });

    it('fails closed when enforcement is on but no key is configured', async () => {
      process.env.AIBOT_SYSTEM_EXPORT_REQUIRE_ADMIN_KEY = 'true';
      // biome-ignore lint/performance/noDelete: the variable must be absent
      delete process.env.ADMIN_API_KEY;

      const res = await createApp().request('/api/system/export');
      expect(res.status).toBe(503);
    });
  });

  describe('POST /import', () => {
    async function exportBundle(): Promise<Buffer> {
      const res = await createApp().request('/api/system/export');
      return Buffer.from(await res.arrayBuffer());
    }

    it('rejects an unsupported content type', async () => {
      const res = await createApp().request('/api/system/import', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'nope',
      });
      expect(res.status).toBe(400);
    });

    it('rejects an empty upload', async () => {
      const res = await createApp().request('/api/system/import', {
        method: 'POST',
        headers: { 'content-type': 'application/gzip' },
        body: new Uint8Array(0),
      });
      expect(res.status).toBe(400);
    });

    it('returns 409 when the target already has the same state', async () => {
      const bundle = await exportBundle();
      const res = await createApp().request('/api/system/import', {
        method: 'POST',
        headers: { 'content-type': 'application/gzip' },
        body: new Uint8Array(bundle),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain('overwrite=true');
    });

    it('returns 422 for a bundle this build cannot read', async () => {
      const { packTarGz } = await import('../../../src/system/tar-archive');
      const bogus = packTarGz([
        { path: 'manifest.json', data: Buffer.from(JSON.stringify({ version: 1, botId: 'x' })) },
      ]);

      const res = await createApp().request('/api/system/import', {
        method: 'POST',
        headers: { 'content-type': 'application/gzip' },
        body: new Uint8Array(bogus),
      });
      expect(res.status).toBe(422);
    });

    it('refuses while an agent is running', async () => {
      const bundle = await exportBundle();
      const deps = makeDeps({ botManager: { isRunning: () => true } as any });

      const res = await createApp(deps).request('/api/system/import?overwrite=true', {
        method: 'POST',
        headers: { 'content-type': 'application/gzip' },
        body: new Uint8Array(bundle),
      });

      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('Stop all running agents');
    });

    it('accepts a dry run and writes nothing', async () => {
      const bundle = await exportBundle();
      const res = await createApp().request('/api/system/import?dryRun=true&overwrite=true', {
        method: 'POST',
        headers: { 'content-type': 'application/gzip' },
        body: new Uint8Array(bundle),
      });

      const result = await res.json();
      expect(res.status).toBe(200);
      expect(result.dryRun).toBe(true);
      expect(result.filesWritten).toBe(0);
    });

    it('accepts a multipart upload', async () => {
      const bundle = await exportBundle();
      const form = new FormData();
      form.append('file', new File([new Uint8Array(bundle)], 'bundle.tar.gz'));

      const res = await createApp().request('/api/system/import?dryRun=true', {
        method: 'POST',
        body: form,
      });

      expect(res.status).toBe(200);
      expect((await res.json()).dryRun).toBe(true);
    });
  });
});

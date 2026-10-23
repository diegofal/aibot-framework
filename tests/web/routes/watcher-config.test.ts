import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import { WATCHER_DEFAULTS } from '../../../src/watcher/types';
import { Watcher } from '../../../src/watcher/watcher';
import { watcherRoutes } from '../../../src/web/routes/watcher';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watcher-config-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const TOKEN_REF = ['$', '{TELEGRAM_TOKEN}'].join('');
const RAW = {
  telegram: { token: TOKEN_REF },
  watcher: { enabled: true, notice: { enabled: false, model: 'claude-haiku-5-5' } },
};

function setup(opts: { enabled?: boolean; raw?: unknown } = {}) {
  const enabled = opts.enabled ?? true;
  const configPath = join(root, 'config', 'config.json');
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(opts.raw ?? RAW, null, 2)}\n`);
  const soulDir = join(root, 'souls', 'b1');
  mkdirSync(soulDir, { recursive: true });
  writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Jarvis\n');
  const config = {
    bots: [{ id: 'b1', name: 'b1', soulDir, enabled: true }],
    paths: { data: join(root, 'data') },
    soul: {},
    operator: {},
    watcher: structuredClone({ ...WATCHER_DEFAULTS, enabled }),
  } as unknown as Config;
  const watcher = enabled
    ? new Watcher({
        config: () => config,
        logger: noopLogger,
        activityStream: new EventEmitter(),
        hooks: new EventEmitter(),
        botManager: {
          getChannelState: () => undefined,
          getUserDirectory: () => ({ list: () => [], findByChannel: () => undefined }) as never,
        },
      })
    : undefined;
  return { config, watcher, configPath };
}

function app(config: Config, watcher: Watcher | undefined, configPath: string, tenantId?: string) {
  const a = new Hono();
  if (tenantId) {
    a.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  a.route(
    '/api/watcher',
    watcherRoutes({ config, logger: noopLogger, watcher: () => watcher, configPath })
  );
  return a;
}

const postJson = (a: Hono, body: unknown) =>
  a.request('/api/watcher/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/watcher/config', () => {
  it('updates the live config, persists only the patched fields, no .bak (no inline secrets copied), applies the timers', async () => {
    const { config, watcher, configPath } = setup();
    let applied = 0;
    const w = watcher as Watcher;
    const orig = w.applyConfig.bind(w);
    w.applyConfig = () => {
      applied++;
      orig();
    };
    const res = await postJson(app(config, watcher, configPath), {
      notice: { enabled: true, maxPerDay: 50 },
      integrate: { maxPerDay: 3 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config).toEqual({
      notice: { enabled: true, maxPerDay: 50 },
      integrate: { enabled: false, maxPerDay: 3 },
    });
    expect(config.watcher?.notice.enabled).toBe(true);
    expect(config.watcher?.notice.maxPerDay).toBe(50);
    expect(config.watcher?.integrate.maxPerDay).toBe(3);
    expect(applied).toBe(1);
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(raw.telegram.token).toBe(TOKEN_REF);
    expect(raw.watcher.notice).toEqual({ enabled: true, model: 'claude-haiku-5-5', maxPerDay: 50 });
    expect(raw.watcher.integrate).toEqual({ maxPerDay: 3 });
    // deliberate: no .bak copy (it duplicated inline secrets in the volume); the backup script covers it
    expect(existsSync(`${configPath}.bak`)).toBe(false);
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it('a config file without a watcher block gets one', async () => {
    const { config, watcher, configPath } = setup({ raw: { telegram: {} } });
    const res = await postJson(app(config, watcher, configPath), { integrate: { enabled: true } });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).watcher).toEqual({
      integrate: { enabled: true },
    });
  });

  const invalid: Array<[string, unknown]> = [
    ['negative cap', { notice: { maxPerDay: -1 } }],
    ['fractional cap', { integrate: { maxPerDay: 1.5 } }],
    ['non-boolean switch', { notice: { enabled: 'yes' } }],
    ['unknown tier field', { notice: { model: 'opus' } }],
    ['unknown top-level key', { graph: { maxNeurons: 5 } }],
    ['empty patch', {}],
    ['not an object', [1]],
  ];
  for (const [label, body] of invalid) {
    it(`rejects ${label} with 400 and writes nothing`, async () => {
      const { config, watcher, configPath } = setup();
      const before = readFileSync(configPath, 'utf-8');
      const res = await postJson(app(config, watcher, configPath), body);
      expect(res.status).toBe(400);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(existsSync(`${configPath}.bak`)).toBe(false);
      expect(config.watcher?.notice.enabled).toBe(false);
    });
  }

  it('a file whose watcher block fails WatcherConfigSchema is not written', async () => {
    const raw = { watcher: { notice: { everyMs: 5 } } };
    const { config, watcher, configPath } = setup({ raw });
    const res = await postJson(app(config, watcher, configPath), { notice: { enabled: true } });
    expect(res.status).toBe(400);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(raw);
    expect(config.watcher?.notice.enabled).toBe(false);
  });

  it('404 for a tenant and when the watcher is off', async () => {
    const a = setup();
    const tenant = await postJson(app(a.config, a.watcher, a.configPath, 't1'), {
      notice: { enabled: true },
    });
    expect(tenant.status).toBe(404);
    const b = setup({ enabled: false });
    const res = await postJson(app(b.config, b.watcher, b.configPath), {
      notice: { enabled: true },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).enabled).toBe(false);
  });

  it('GET / carries the tier switches and caps', async () => {
    const { config, watcher, configPath } = setup();
    const body = await (await app(config, watcher, configPath).request('/api/watcher')).json();
    expect(body.config).toEqual({
      notice: { enabled: false, maxPerDay: 288 },
      integrate: { enabled: false, maxPerDay: 24 },
    });
  });
});

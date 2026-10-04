/**
 * Face and voice routes (session S4 of docs/plans/jarvis-fleet-plan.md):
 *   GET/POST/DELETE /api/agents/:id/avatar and POST /api/agents/:id/speak.
 * `generateSpeech` is always mocked — no ElevenLabs credits in tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AVATAR_MAX_BYTES } from '../../../src/bot/agent-avatar';
import type { BotConfig, Config, TtsConfig } from '../../../src/config';
import {
  SPEAK_MAX_CHARS,
  agentFaceRoutes,
  audioContentType,
} from '../../../src/web/routes/agent-face';
import { agentHomeRoutes } from '../../../src/web/routes/agent-home';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';
import { createStatsFixture } from '../../stats/fixture';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
// "OggS" + version 0 + header type 2 + a few bytes
const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x72, 0x65, 0x73, 0x74]);
const ID3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x61, 0x62, 0x63]);
const MP3_SYNC = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

const JSON_POST = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

let dir: string;
beforeEach(() => {
  dir = createTempDir('agent-face');
});
afterEach(() => removeTempDir(dir));

function makeConfig(tts?: Partial<TtsConfig>, botTts?: BotConfig['tts']): Config {
  const bots: BotConfig[] = [
    { id: 'b1', name: 'Bot One', token: '', enabled: true, skills: [], tts: botTts } as BotConfig,
    {
      id: 'b3',
      name: 'Bot Three',
      token: '',
      enabled: true,
      skills: [],
      tenantId: 't2',
    } as BotConfig,
  ];
  return {
    bots,
    soul: { dir: join(dir, 'soul') },
    media: tts ? { enabled: true, maxFileSizeMb: 10, tts } : { enabled: false, maxFileSizeMb: 10 },
  } as unknown as Config;
}

function makeApp(
  opts: {
    config?: Config;
    tenantId?: string;
    speak?: (text: string, cfg: TtsConfig) => Promise<{ audioBuffer: Buffer; latencyMs: number }>;
  } = {}
) {
  const app = new Hono();
  if (opts.tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: opts.tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  app.route(
    '/api/agents',
    agentFaceRoutes({
      config: opts.config ?? makeConfig(),
      logger: noopLogger,
      soulDirOf: (bot) => join(dir, 'souls', bot.id),
      speak: opts.speak as never,
    })
  );
  return app;
}

const post = (body: Buffer, type = 'image/png', extra: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': type, ...extra },
  body: body as unknown as BodyInit,
});

function homeApp(config: Config, now: number) {
  const app = new Hono();
  app.route(
    '/api/agents',
    agentHomeRoutes({
      config,
      botManager: {
        isRunning: () => true,
        getAgentLoopState: () => ({ botSchedules: [] }) as never,
      },
      logger: noopLogger,
      now: () => now,
    })
  );
  return app;
}

describe('POST /api/agents/:id/avatar', () => {
  it('stores a raw PNG body in the soul dir and returns the versioned url', async () => {
    const res = await makeApp().request('/api/agents/b1/avatar', post(PNG));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contentType).toBe('image/png');
    expect(body.size).toBe(PNG.length);
    expect(body.avatarUrl).toMatch(/^\/api\/agents\/b1\/avatar\?v=\d+$/);
    expect(readFileSync(join(dir, 'souls', 'b1', 'avatar.png'))).toEqual(PNG);
  });
  it('accepts multipart/form-data with a `file` field', async () => {
    const fd = new FormData();
    fd.append('file', new File([JPEG], 'face.jpg', { type: 'image/jpeg' }));
    const res = await makeApp().request('/api/agents/b1/avatar', { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    expect((await res.json()).contentType).toBe('image/jpeg');
    expect(existsSync(join(dir, 'souls', 'b1', 'avatar.jpg'))).toBe(true);
  });
  it('trusts the bytes, not the declared type', async () => {
    const res = await makeApp().request('/api/agents/b1/avatar', post(JPEG, 'image/png'));
    expect((await res.json()).contentType).toBe('image/jpeg');
  });
  it('415 for a non PNG/JPEG body, 400 for an empty one', async () => {
    const gif = await makeApp().request(
      '/api/agents/b1/avatar',
      post(Buffer.from('GIF89a....'), 'image/gif')
    );
    expect(gif.status).toBe(415);
    expect((await gif.json()).error).toContain('PNG');
    const empty = await makeApp().request('/api/agents/b1/avatar', post(Buffer.alloc(0)));
    expect(empty.status).toBe(400);
    expect(existsSync(join(dir, 'souls', 'b1'))).toBe(false);
  });
  it('413 over 512 KB (raw body and multipart file)', async () => {
    // The route also rejects on Content-Length before reading the body, but
    // `Request` normalises that header to the real size, so only the byte
    // path is observable here.
    const big = Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]);
    const byBytes = await makeApp().request('/api/agents/b1/avatar', post(big));
    expect(byBytes.status).toBe(413);
    expect((await byBytes.json()).error).toContain('512');
    const fd = new FormData();
    fd.append('file', new File([big], 'big.png', { type: 'image/png' }));
    const multipart = await makeApp().request('/api/agents/b1/avatar', {
      method: 'POST',
      body: fd,
    });
    expect(multipart.status).toBe(413);
    expect(existsSync(join(dir, 'souls', 'b1'))).toBe(false);
  });
  it('404 for unknown bots and bots outside the tenant', async () => {
    expect((await makeApp().request('/api/agents/nope/avatar', post(PNG))).status).toBe(404);
    expect(
      (await makeApp({ tenantId: 't1' }).request('/api/agents/b3/avatar', post(PNG))).status
    ).toBe(404);
    expect(
      (await makeApp({ tenantId: 't2' }).request('/api/agents/b3/avatar', post(PNG))).status
    ).toBe(200);
  });
});

describe('GET /api/agents/:id/avatar', () => {
  it('404 JSON when there is no face', async () => {
    const res = await makeApp().request('/api/agents/b1/avatar');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No avatar');
  });
  it('serves the bytes with the right type, no-cache and an ETag honoured by If-None-Match', async () => {
    const app = makeApp();
    await app.request('/api/agents/b1/avatar', post(JPEG));
    const res = await app.request('/api/agents/b1/avatar');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[^"]+"$/);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
    const again = await app.request('/api/agents/b1/avatar', {
      headers: { 'If-None-Match': etag as string },
    });
    expect(again.status).toBe(304);
  });
  it('404 outside the tenant even when a file exists', async () => {
    mkdirSync(join(dir, 'souls', 'b3'), { recursive: true });
    writeFileSync(join(dir, 'souls', 'b3', 'avatar.png'), PNG);
    expect((await makeApp({ tenantId: 't1' }).request('/api/agents/b3/avatar')).status).toBe(404);
    expect((await makeApp({ tenantId: 't2' }).request('/api/agents/b3/avatar')).status).toBe(200);
  });
});

describe('DELETE /api/agents/:id/avatar', () => {
  it('removes the file and says whether there was one', async () => {
    const app = makeApp();
    await app.request('/api/agents/b1/avatar', post(PNG));
    const first = await app.request('/api/agents/b1/avatar', { method: 'DELETE' });
    expect(await first.json()).toEqual({ ok: true, removed: true });
    expect(existsSync(join(dir, 'souls', 'b1', 'avatar.png'))).toBe(false);
    const second = await app.request('/api/agents/b1/avatar', { method: 'DELETE' });
    expect(await second.json()).toEqual({ ok: true, removed: false });
    expect(
      (await makeApp({ tenantId: 't1' }).request('/api/agents/b3/avatar', { method: 'DELETE' }))
        .status
    ).toBe(404);
  });
});

describe('avatar shows up in the home payload', () => {
  it('populates identity.avatarUrl and the fleet entry from the same soul dir the route wrote', async () => {
    const fx = createStatsFixture();
    try {
      const before = await (await homeApp(fx.config, fx.now).request('/api/agents/b1/home')).json();
      expect(before.identity.avatarUrl).toBeNull();
      expect(before.identity.voiceEnabled).toBe(false);

      const face = new Hono();
      face.route('/api/agents', agentFaceRoutes({ config: fx.config, logger: noopLogger }));
      const up = await face.request('/api/agents/b1/avatar', post(PNG));
      expect(up.status).toBe(200);
      expect(existsSync(join(fx.soulDir('b1'), 'avatar.png'))).toBe(true);

      const app2 = homeApp(fx.config, fx.now + 60_000);
      const after = await (await app2.request('/api/agents/b1/home')).json();
      expect(after.identity.avatarUrl).toMatch(/^\/api\/agents\/b1\/avatar\?v=\d+$/);
      const fleet = await (await app2.request('/api/agents/presence')).json();
      expect(fleet.agents.b1.avatarUrl).toBe(after.identity.avatarUrl);
      expect(fleet.agents.b2.avatarUrl).toBeNull();
    } finally {
      removeTempDir(fx.dir);
    }
  });
  it('identity.voiceEnabled follows media.tts.apiKey', async () => {
    const fx = createStatsFixture();
    try {
      (fx.config as { media?: unknown }).media = { enabled: true, tts: { apiKey: 'k' } };
      const home = await (await homeApp(fx.config, fx.now).request('/api/agents/b1/home')).json();
      expect(home.identity.voiceEnabled).toBe(true);
    } finally {
      removeTempDir(fx.dir);
    }
  });
});

const TTS: Partial<TtsConfig> = {
  provider: 'elevenlabs',
  apiKey: 'xi-key',
  voiceId: 'global-voice',
  modelId: 'eleven_multilingual_v2',
  outputFormat: 'opus_48000_64',
  timeout: 1000,
  maxTextLength: 1500,
  voiceSettings: {
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0,
    useSpeakerBoost: true,
    speed: 1,
  },
};

describe('POST /api/agents/:id/speak', () => {
  it('503 with a clear message when TTS is not configured', async () => {
    const res = await makeApp().request('/api/agents/b1/speak', JSON_POST({ text: 'hello' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('TTS');
  });
  it("speaks with the bot's voice, falling back to the global one, and streams audio", async () => {
    const calls: Array<{ text: string; voiceId: string }> = [];
    const speak = async (text: string, cfg: TtsConfig) => {
      calls.push({ text, voiceId: cfg.voiceId });
      return { audioBuffer: OGG, latencyMs: 42 };
    };
    const own = makeApp({ config: makeConfig(TTS, { voiceId: 'own-voice' }), speak });
    const res = await own.request(
      '/api/agents/b1/speak',
      JSON_POST({ text: "I'm working: running web_search." })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/ogg');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-tts-latency-ms')).toBe('42');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(OGG);
    expect(calls[0]).toEqual({ text: "I'm working: running web_search.", voiceId: 'own-voice' });

    const global = makeApp({ config: makeConfig(TTS), speak });
    await global.request('/api/agents/b1/speak', JSON_POST({ text: 'hi' }));
    expect(calls[1].voiceId).toBe('global-voice');
  });
  it('400 for missing, blank or oversized text and never calls TTS', async () => {
    let called = 0;
    const speak = async () => {
      called++;
      return { audioBuffer: OGG, latencyMs: 1 };
    };
    const app = makeApp({ config: makeConfig(TTS), speak });
    const send = (body: unknown) => app.request('/api/agents/b1/speak', JSON_POST(body));
    expect((await send({})).status).toBe(400);
    expect((await send({ text: '   ' })).status).toBe(400);
    expect((await send({ text: 'x'.repeat(SPEAK_MAX_CHARS + 1) })).status).toBe(400);
    expect((await send('not json')).status).toBe(400);
    expect(called).toBe(0);
  });
  it('502 when ElevenLabs fails, 504 on timeout', async () => {
    const failing = makeApp({
      config: makeConfig(TTS),
      speak: async () => {
        throw new Error('ElevenLabs API error (401)');
      },
    });
    const res = await failing.request('/api/agents/b1/speak', JSON_POST({ text: 'hi' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('401');
    const slow = makeApp({
      config: makeConfig(TTS),
      speak: async () => {
        throw new Error('TTS timeout after 1000ms');
      },
    });
    expect((await slow.request('/api/agents/b1/speak', JSON_POST({ text: 'hi' }))).status).toBe(
      504
    );
  });
  it('404 outside the tenant', async () => {
    const app = makeApp({
      config: makeConfig(TTS),
      tenantId: 't1',
      speak: async () => ({ audioBuffer: OGG, latencyMs: 1 }),
    });
    expect((await app.request('/api/agents/b3/speak', JSON_POST({ text: 'hi' }))).status).toBe(404);
  });
});

describe('audioContentType', () => {
  it('sniffs the container first, then maps the ElevenLabs format', () => {
    expect(audioContentType('mp3_44100_128', OGG)).toBe('audio/ogg');
    expect(audioContentType('opus_48000_64', ID3)).toBe('audio/mpeg');
    expect(audioContentType('opus_48000_64', MP3_SYNC)).toBe('audio/mpeg');
    expect(audioContentType('mp3_22050_32')).toBe('audio/mpeg');
    expect(audioContentType('opus_48000_64')).toBe('audio/ogg');
    expect(audioContentType('pcm_16000')).toBe('audio/L16');
    expect(audioContentType('ulaw_8000')).toBe('audio/basic');
    expect(audioContentType('whatever')).toBe('application/octet-stream');
  });
});

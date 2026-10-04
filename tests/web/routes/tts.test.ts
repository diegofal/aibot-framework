/**
 * GET /api/tts/voices — the ElevenLabs voice list, cached 10 minutes so the
 * Config form can fill its select on every render without hammering the API.
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import { VOICES_CACHE_TTL_MS, ttsRoutes } from '../../../src/web/routes/tts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

function makeConfig(tts?: Record<string, unknown>): Config {
  return {
    bots: [],
    media: tts ? { enabled: true, maxFileSizeMb: 10, tts } : { enabled: false, maxFileSizeMb: 10 },
  } as unknown as Config;
}

function upstream(voices: unknown[], status = 200) {
  const calls: Array<{ url: string; key: string | undefined }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, key: (init?.headers as Record<string, string>)?.['xi-api-key'] });
    return new Response(JSON.stringify({ voices }), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const RAW = [
  {
    voice_id: 'v1',
    name: 'Rachel',
    labels: { gender: 'female', accent: 'american' },
    preview_url: 'https://x/r.mp3',
    settings: { secret: 'strip me' },
  },
  { voice_id: 'v2', name: 'Adam', labels: {}, preview_url: null },
];

function makeApp(opts: { config?: Config; fetchFn?: typeof fetch; now?: () => number } = {}) {
  const app = new Hono();
  app.route(
    '/api/tts',
    ttsRoutes({
      config: opts.config ?? makeConfig({ apiKey: 'xi', voiceId: 'v2' }),
      logger: noopLogger,
      fetch: opts.fetchFn,
      now: opts.now,
    })
  );
  return app;
}

describe('GET /api/tts/voices', () => {
  it('503 when TTS is not configured (no media.tts or no apiKey)', async () => {
    expect((await makeApp({ config: makeConfig() }).request('/api/tts/voices')).status).toBe(503);
    const res = await makeApp({ config: makeConfig({ voiceId: 'v' }) }).request('/api/tts/voices');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('TTS');
  });
  it('returns the simplified list with the global default voice and caches it', async () => {
    const { calls, fetchFn } = upstream(RAW);
    let t = 1_700_000_000_000;
    const app = makeApp({ fetchFn, now: () => t });
    const first = await app.request('/api/tts/voices');
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.defaultVoiceId).toBe('v2');
    expect(body.voices).toEqual([
      {
        voice_id: 'v1',
        name: 'Rachel',
        labels: { gender: 'female', accent: 'american' },
        preview_url: 'https://x/r.mp3',
      },
      { voice_id: 'v2', name: 'Adam', labels: {}, preview_url: null },
    ]);
    expect(body.cachedAt).toBe(new Date(t).toISOString());
    expect(calls[0].key).toBe('xi');
    expect(calls[0].url).toContain('api.elevenlabs.io/v1/voices');

    t += VOICES_CACHE_TTL_MS - 1;
    const second = await (await app.request('/api/tts/voices')).json();
    expect(second.cachedAt).toBe(body.cachedAt);
    expect(calls.length).toBe(1);

    t += 2;
    const third = await (await app.request('/api/tts/voices')).json();
    expect(third.cachedAt).not.toBe(body.cachedAt);
    expect(calls.length).toBe(2);
  });
  it('?refresh=1 bypasses the cache', async () => {
    const { calls, fetchFn } = upstream(RAW);
    const app = makeApp({ fetchFn, now: () => 1 });
    await app.request('/api/tts/voices');
    await app.request('/api/tts/voices?refresh=1');
    expect(calls.length).toBe(2);
  });
  it('502 on an upstream error and does not cache the failure', async () => {
    let status = 500;
    const fetchFn = (async () =>
      new Response(JSON.stringify({ voices: RAW }), { status })) as typeof fetch;
    const app = makeApp({ fetchFn, now: () => 1 });
    const bad = await app.request('/api/tts/voices');
    expect(bad.status).toBe(502);
    expect((await bad.json()).error).toContain('500');
    status = 200;
    expect((await app.request('/api/tts/voices')).status).toBe(200);
  });
  it('502 when the upstream call throws', async () => {
    const fetchFn = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    const res = await makeApp({ fetchFn }).request('/api/tts/voices');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('boom');
  });
});

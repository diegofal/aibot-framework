/**
 * Fleet-level TTS helpers (session S4 of docs/plans/jarvis-fleet-plan.md).
 *
 *   GET /api/tts/voices[?refresh=1]   ElevenLabs voice list, cached 10 minutes
 *
 * The Config form fills its voice select from this on every render, so the
 * list is cached in-process and the API key never leaves the server. 503
 * when `media.tts.apiKey` is missing, 502 when ElevenLabs fails (never
 * cached). `/api/integrations/elevenlabs/voices` (uncached, 400 when
 * unconfigured) is left as it was for the Integrations page.
 */
import { Hono } from 'hono';
import type { Config } from '../../config';
import type { Logger } from '../../logger';

export const VOICES_CACHE_TTL_MS = 10 * 60_000;
const ELEVENLABS_VOICES_URL = 'https://api.elevenlabs.io/v1/voices';
const UPSTREAM_TIMEOUT_MS = 10_000;

export interface TtsVoice {
  voice_id: string;
  name: string;
  labels: Record<string, unknown> | null;
  preview_url: string | null;
}

export interface TtsVoicesResponse {
  voices: TtsVoice[];
  defaultVoiceId: string | null;
  cachedAt: string;
}

export interface TtsRouteDeps {
  config: Config;
  logger: Logger;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

function simplify(raw: unknown): TtsVoice[] {
  const list = Array.isArray((raw as { voices?: unknown })?.voices)
    ? ((raw as { voices: unknown[] }).voices as Array<Record<string, unknown>>)
    : [];
  return list
    .filter((v) => v && typeof v.voice_id === 'string')
    .map((v) => ({
      voice_id: String(v.voice_id),
      name: typeof v.name === 'string' ? v.name : String(v.voice_id),
      labels:
        v.labels && typeof v.labels === 'object' ? (v.labels as Record<string, unknown>) : null,
      preview_url: typeof v.preview_url === 'string' ? v.preview_url : null,
    }));
}

export function ttsRoutes(deps: TtsRouteDeps) {
  const app = new Hono();
  const now = deps.now ?? (() => Date.now());
  const fetchFn = deps.fetch ?? fetch;
  let cache: { expiresAt: number; body: TtsVoicesResponse } | null = null;

  app.get('/voices', async (c) => {
    const tts = deps.config.media?.tts;
    if (!tts?.apiKey) {
      return c.json(
        { error: 'TTS is not configured: set media.tts.apiKey (ElevenLabs) in the config' },
        503
      );
    }
    const t = now();
    const refresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
    if (cache && cache.expiresAt > t && !refresh) return c.json(cache.body);

    try {
      const res = await fetchFn(ELEVENLABS_VOICES_URL, {
        headers: { 'xi-api-key': tts.apiKey },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        deps.logger.warn({ status: res.status }, 'ElevenLabs voices fetch failed');
        return c.json({ error: `ElevenLabs API error (${res.status})` }, 502);
      }
      const body: TtsVoicesResponse = {
        voices: simplify(await res.json()),
        defaultVoiceId: tts.voiceId ?? null,
        cachedAt: new Date(t).toISOString(),
      };
      cache = { expiresAt: t + VOICES_CACHE_TTL_MS, body };
      return c.json(body);
    } catch (err) {
      deps.logger.warn({ err }, 'ElevenLabs voices fetch threw');
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  return app;
}

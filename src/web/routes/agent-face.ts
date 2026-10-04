/**
 * Face and voice for one agent (session S4 of docs/plans/jarvis-fleet-plan.md).
 *
 *   GET    /api/agents/:id/avatar   the uploaded face (image/png | image/jpeg), ETag + no-cache
 *   POST   /api/agents/:id/avatar   upload: raw image body, or multipart with a `file` field
 *   DELETE /api/agents/:id/avatar   remove the face
 *   POST   /api/agents/:id/speak    { text } -> audio in the bot's voice (global voice as fallback)
 *
 * Tenant-scoped like the rest of /api/agents. The face lives in the bot's
 * soul dir (`src/bot/agent-avatar.ts`) resolved exactly the way the stats
 * aggregator resolves it, so `identity.avatarUrl` and this route agree.
 * `speak` is the only thing here that costs money; tests inject `speak`.
 */
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import {
  AVATAR_MAX_BYTES,
  AvatarValidationError,
  avatarUrl,
  findAvatar,
  removeAvatar,
  writeAvatar,
} from '../../bot/agent-avatar';
import { type BotConfig, type Config, resolveTtsConfig } from '../../config';
import type { Logger } from '../../logger';
import { resolveBotPaths } from '../../stats/paths';
import { getTenantId, isBotAccessible } from '../../tenant/tenant-scoping';
import { generateSpeech } from '../../tts';

export const SPEAK_MAX_CHARS = 2000;

export interface AgentFaceRouteDeps {
  config: Config;
  logger: Logger;
  /** Where a bot's face lives. Defaults to the stats resolver (tenant-aware). */
  soulDirOf?: (bot: BotConfig) => string;
  /** TTS engine; defaults to `generateSpeech`. Tests inject a stub. */
  speak?: typeof generateSpeech;
}

const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const ID3_MAGIC = [0x49, 0x44, 0x33]; // "ID3"

function startsWith(buf: Uint8Array, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
  return true;
}

/**
 * MIME type for a TTS result: the container in the bytes wins (ElevenLabs
 * wraps opus in Ogg), then the configured `outputFormat` prefix decides.
 */
export function audioContentType(outputFormat: string, buffer?: Uint8Array): string {
  if (buffer) {
    if (startsWith(buffer, OGG_MAGIC)) return 'audio/ogg';
    if (startsWith(buffer, ID3_MAGIC)) return 'audio/mpeg';
    if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
      return 'audio/mpeg';
    }
  }
  const prefix = String(outputFormat ?? '')
    .toLowerCase()
    .split('_')[0];
  switch (prefix) {
    case 'mp3':
      return 'audio/mpeg';
    case 'opus':
      return 'audio/ogg';
    case 'pcm':
      return 'audio/L16';
    case 'ulaw':
      return 'audio/basic';
    case 'alaw':
      return 'audio/alaw';
    default:
      return 'application/octet-stream';
  }
}

function etagFor(size: number, mtimeMs: number): string {
  return `"${Math.floor(mtimeMs).toString(36)}-${size.toString(36)}"`;
}

export function agentFaceRoutes(deps: AgentFaceRouteDeps) {
  const app = new Hono();
  const soulDirOf = deps.soulDirOf ?? ((bot) => resolveBotPaths(deps.config, bot).soulDir);
  const speak = deps.speak ?? generateSpeech;

  const findBot = (c: import('hono').Context): BotConfig | null => {
    const id = c.req.param('id');
    const bot = deps.config.bots.find((b) => b.id === id);
    if (!bot || !isBotAccessible(bot, getTenantId(c))) return null;
    return bot;
  };

  app.get('/:id/avatar', (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);
    const file = findAvatar(soulDirOf(bot));
    if (!file) return c.json({ error: 'No avatar' }, 404);
    const etag = etagFor(file.size, file.mtimeMs);
    const headers: Record<string, string> = {
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers });
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(file.path);
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Avatar read failed');
      return c.json({ error: 'No avatar' }, 404);
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...headers,
        'Content-Type': file.contentType,
        'Content-Length': String(bytes.length),
      },
    });
  });

  app.post('/:id/avatar', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const declared = Number(c.req.header('Content-Length'));
    if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES + 4096) {
      return c.json({ error: `Avatar must be at most ${AVATAR_MAX_BYTES / 1024} KB` }, 413);
    }

    let bytes: Buffer;
    try {
      const type = c.req.header('Content-Type') ?? '';
      if (type.toLowerCase().startsWith('multipart/form-data')) {
        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) {
          return c.json({ error: 'Multipart upload needs a `file` field' }, 400);
        }
        if (file.size > AVATAR_MAX_BYTES) {
          return c.json({ error: `Avatar must be at most ${AVATAR_MAX_BYTES / 1024} KB` }, 413);
        }
        bytes = Buffer.from(await file.arrayBuffer());
      } else {
        bytes = Buffer.from(await c.req.arrayBuffer());
      }
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Avatar upload body could not be read');
      return c.json({ error: 'Could not read the upload' }, 400);
    }

    try {
      const file = writeAvatar(soulDirOf(bot), bytes);
      deps.logger.info(
        { botId: bot.id, contentType: file.contentType, size: file.size },
        'Avatar uploaded'
      );
      return c.json({
        ok: true,
        avatarUrl: avatarUrl(bot.id, file),
        contentType: file.contentType,
        size: file.size,
      });
    } catch (err) {
      if (err instanceof AvatarValidationError) {
        const status = err.code === 'too-large' ? 413 : err.code === 'bad-type' ? 415 : 400;
        return c.json({ error: err.message, code: err.code }, status);
      }
      deps.logger.error({ err, botId: bot.id }, 'Avatar write failed');
      return c.json({ error: 'Could not store the avatar' }, 500);
    }
  });

  app.delete('/:id/avatar', (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);
    const removed = removeAvatar(soulDirOf(bot));
    if (removed) deps.logger.info({ botId: bot.id }, 'Avatar removed');
    return c.json({ ok: true, removed });
  });

  app.post('/:id/speak', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Agent not found' }, 404);

    const globalTts = deps.config.media?.tts;
    if (!globalTts?.apiKey) {
      return c.json(
        { error: 'TTS is not configured: set media.tts.apiKey (ElevenLabs) in the config' },
        503
      );
    }

    const body = await c.req.json<{ text?: unknown }>().catch(() => null);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: 'text is required' }, 400);
    if (text.length > SPEAK_MAX_CHARS) {
      return c.json({ error: `text must be at most ${SPEAK_MAX_CHARS} characters` }, 400);
    }

    const ttsConfig = resolveTtsConfig(globalTts, bot);
    try {
      const result = await speak(text, ttsConfig, deps.logger);
      const contentType = audioContentType(ttsConfig.outputFormat, result.audioBuffer);
      return new Response(new Uint8Array(result.audioBuffer), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(result.audioBuffer.length),
          'Cache-Control': 'no-store',
          'X-TTS-Latency-Ms': String(result.latencyMs),
          'X-TTS-Voice-Id': ttsConfig.voiceId,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /timeout/i.test(message) ? 504 : 502;
      deps.logger.warn({ err, botId: bot.id, voiceId: ttsConfig.voiceId }, 'Speak failed');
      return c.json({ error: message }, status);
    }
  });

  return app;
}

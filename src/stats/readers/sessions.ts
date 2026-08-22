import { join } from 'node:path';
import { readJsonSafe, toMs } from '../util';

interface SessionMetaLike {
  lastActivityAt?: string;
  messageCount?: number;
}

/**
 * Latest activity on any Telegram/web chat session of the bot, from
 * `sessions/sessions.json`. Session keys look like `bot:<botId>:<chatType>:…`.
 * Transcript lines carry no timestamps, so `lastActivityAt` of the session
 * (which only moves when a user message arrives) is the best signal for
 * "a human talked to this bot".
 */
export function lastSessionActivityAt(sessionsDir: string, botId: string): number | null {
  const raw = readJsonSafe<Record<string, SessionMetaLike>>(join(sessionsDir, 'sessions.json'));
  if (!raw || typeof raw !== 'object') return null;
  const prefix = `bot:${botId}:`;
  let best: number | null = null;
  for (const [key, meta] of Object.entries(raw)) {
    if (!key.startsWith(prefix) || !meta) continue;
    if (!(Number(meta.messageCount) > 0)) continue;
    const t = toMs(meta.lastActivityAt);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

import { join } from 'node:path';
import type { KarmaEvent } from '../../karma/types';
import type { KarmaStats } from '../types';
import { readJsonlSafe, toMs } from '../util';

/** The only part of KarmaService the stats reader needs. */
export interface KarmaScoreSource {
  getScore(botId: string): number;
}

/**
 * Karma for the window: `delta` and `events` come straight from the JSONL
 * event log; `score` comes from the service (it applies temporal decay the
 * reader should not re-implement) and is null when no service is wired.
 */
export function readKarmaStats(
  baseDir: string,
  botId: string,
  sinceMs: number,
  service?: KarmaScoreSource
): KarmaStats {
  const events = readJsonlSafe<KarmaEvent>(join(baseDir, botId, 'events.jsonl'));
  let delta = 0;
  let count = 0;
  for (const e of events) {
    const t = toMs(e.timestamp);
    if (t === null || t < sinceMs) continue;
    delta += Number(e.delta) || 0;
    count++;
  }
  let score: number | null = null;
  if (service) {
    try {
      score = service.getScore(botId);
    } catch {
      score = null;
    }
  }
  return { score, delta: Math.round(delta * 100) / 100, events: count };
}

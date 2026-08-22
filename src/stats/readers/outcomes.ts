import { join } from 'node:path';
import type { OutcomeEntry } from '../../bot/outcome-ledger';
import { readJsonlSafe, toMs } from '../util';

export interface OutcomeWindowStats {
  /** Every ledger entry recorded inside the window (any status). */
  produced: number;
  /** Entries inside the window whose status is `stale`. */
  stale: number;
  /** Timestamp (ms) of the most recent entry regardless of window. */
  lastAt: number | null;
}

export function readOutcomeStats(
  baseDir: string,
  botId: string,
  sinceMs: number
): OutcomeWindowStats {
  const entries = readJsonlSafe<OutcomeEntry>(join(baseDir, botId, 'outcomes.jsonl'));
  let produced = 0;
  let stale = 0;
  let lastAt: number | null = null;
  for (const e of entries) {
    const t = toMs(e.timestamp);
    if (t === null) continue;
    if (lastAt === null || t > lastAt) lastAt = t;
    if (t < sinceMs) continue;
    produced++;
    if (e.status === 'stale') stale++;
  }
  return { produced, stale, lastAt };
}

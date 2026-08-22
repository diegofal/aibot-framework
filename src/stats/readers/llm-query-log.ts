import type { LlmQueryEntry } from '../../bot/llm-query-log';
import type { LlmStats } from '../types';
import { ratio, toIso, toMs } from '../util';
import { groupByDay, readDailyEntries } from './daily-files';

export type { LlmQueryEntry };

export function readLlmEntries(
  baseDir: string,
  botId: string,
  sinceMs: number,
  nowMs: number
): LlmQueryEntry[] {
  return readDailyEntries<LlmQueryEntry>(baseDir, botId, sinceMs, nowMs);
}

export function aggregateLlm(entries: LlmQueryEntry[]): LlmStats {
  const byCaller: LlmStats['byCaller'] = {};
  const byModel: LlmStats['byModel'] = {};
  let failed = 0;
  let durationSum = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let lastError: string | null = null;
  let lastErrorAt = -1;
  let lastCallAt = -1;

  for (const e of entries) {
    const ok = e.success !== false;
    if (!ok) failed++;
    durationSum += Number(e.durationMs) || 0;
    const pt = Number(e.promptTokens) || 0;
    const ct = Number(e.completionTokens) || 0;
    promptTokens += pt;
    completionTokens += ct;

    const caller = e.caller || 'unknown';
    const c = byCaller[caller] ?? { calls: 0, failed: 0 };
    byCaller[caller] = c;
    c.calls++;
    if (!ok) c.failed++;

    const model = e.model || 'unknown';
    const m = byModel[model] ?? { calls: 0, promptTokens: 0, completionTokens: 0 };
    byModel[model] = m;
    m.calls++;
    m.promptTokens += pt;
    m.completionTokens += ct;

    const t = toMs(e.timestamp) ?? 0;
    if (t > lastCallAt) lastCallAt = t;
    if (!ok && e.error && t >= lastErrorAt) {
      lastErrorAt = t;
      lastError = String(e.error);
    }
  }

  const calls = entries.length;
  return {
    calls,
    failed,
    failRate: ratio(failed, calls),
    avgDurationMs: calls ? Math.round(durationSum / calls) : 0,
    promptTokens,
    completionTokens,
    byCaller,
    byModel,
    lastError,
    lastCallAt: lastCallAt > 0 ? toIso(lastCallAt) : null,
  };
}

export function llmDaily(
  entries: LlmQueryEntry[]
): Array<{ date: string; calls: number; failed: number; promptTokens: number }> {
  return groupByDay(
    entries,
    () => ({ calls: 0, failed: 0, promptTokens: 0 }),
    (acc, e) => {
      acc.calls++;
      if (e.success === false) acc.failed++;
      acc.promptTokens += Number(e.promptTokens) || 0;
    }
  );
}

/** Collapse numbers so "timeout after 1234ms" and "... 99ms" share a bucket. */
export function normaliseErrorMessage(message: string): string {
  return message.replace(/\d+/g, 'N').trim().slice(0, 200);
}

export function topErrors(
  entries: LlmQueryEntry[],
  limit = 10
): Array<{ message: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.success !== false || !e.error) continue;
    const key = normaliseErrorMessage(String(e.error));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, limit);
}

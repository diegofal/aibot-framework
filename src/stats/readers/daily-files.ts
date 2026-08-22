/**
 * Shared reader for the two "one JSONL file per bot per day" stores
 * (`llm-query-log/<botId>/<date>.jsonl`, `tool-audit/<botId>/<date>.jsonl`).
 *
 * Day files are selected by name first (cheap) and the surviving entries are
 * then filtered by their own timestamp, so a file that straddles the window
 * edge contributes only the entries inside it.
 */
import { join } from 'node:path';
import { dateKey, listDirSafe, readJsonlSafe, toMs } from '../util';

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

export function readDailyEntries<T extends { timestamp: string }>(
  baseDir: string,
  botId: string,
  sinceMs: number,
  nowMs: number
): T[] {
  const botDir = join(baseDir, botId);
  // One day of slack on each side: the writer names the file from the entry's
  // own ISO timestamp, but local-vs-UTC differences elsewhere should not hide
  // entries. The per-entry filter below is what actually enforces the window.
  const minKey = dateKey(Math.max(0, sinceMs - DAY_MS));
  const maxKey = dateKey(nowMs + DAY_MS);
  const files = listDirSafe(botDir)
    .map((name) => ({ name, m: DAY_FILE.exec(name) }))
    .filter((f): f is { name: string; m: RegExpExecArray } => f.m !== null)
    .filter((f) => f.m[1] >= minKey && f.m[1] <= maxKey)
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  const out: T[] = [];
  for (const f of files) {
    for (const entry of readJsonlSafe<T>(join(botDir, f.name))) {
      const t = toMs(entry?.timestamp);
      if (t === null || t < sinceMs || t > nowMs + DAY_MS) continue;
      out.push(entry);
    }
  }
  return out;
}

/** Group entries by UTC date, preserving ascending order. */
export function groupByDay<T extends { timestamp: string }, R>(
  entries: T[],
  init: () => R,
  fold: (acc: R, entry: T) => void
): Array<{ date: string } & R> {
  const buckets = new Map<string, R>();
  for (const e of entries) {
    const t = toMs(e.timestamp);
    if (t === null) continue;
    const key = dateKey(t);
    let acc = buckets.get(key);
    if (!acc) {
      acc = init();
      buckets.set(key, acc);
    }
    fold(acc, e);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, acc]) => ({ date, ...acc }));
}

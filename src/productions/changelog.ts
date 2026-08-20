/**
 * Changelog — JSONL read/parse, filter, and stats for ProductionEntry.
 *
 * Extracts all JSONL operations from ProductionsService. Per
 * docs/architecture-docs/productions-refactor.md §4 C4 + §6:
 *   - Pure functions: parseEntries, filterEntries, sortByTimestamp,
 *     filterApproved, filterRejected, getStatsFromEntries, serializeEntries.
 *   - I/O functions: readEntries, writeEntries, appendEntry.
 *
 * Module boundary:
 *   - Pure functions take entries or strings; they return entries or
 *     projections. No filesystem access.
 *   - I/O functions take a path (changelog.jsonl) and do the file I/O.
 *   - No knowledge of bot config, logger, or facade — purely data.
 *
 * Consumed by ProductionsService (via thin wrappers) and by tests
 * (tests/productions/changelog.test.ts).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductionEntry } from './types';

/**
 * Parse JSONL lines into ProductionEntry objects. Skips malformed lines.
 *
 * Pure. Used by readEntries and tests.
 */
export function parseEntries(lines: string[]): ProductionEntry[] {
  const entries: ProductionEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as ProductionEntry);
    } catch {
      // Skip malformed lines (e.g. markdown accidentally written to JSONL).
    }
  }
  return entries;
}

/**
 * Filter entries by since/status/botId.
 *
 * - since: ISO timestamp; keeps entries with timestamp >= since.
 * - status: 'approved' | 'rejected' | 'unreviewed'. 'unreviewed' means
 *           no evaluation.status set.
 * - botId: exact match.
 *
 * Pure. Returns a new array; does not mutate input.
 */
export function filterEntries(
  entries: ProductionEntry[],
  opts?: { since?: string; status?: string; botId?: string }
): ProductionEntry[] {
  if (!opts) return entries;

  let result = entries;

  if (opts.since) {
    const sinceMs = new Date(opts.since).getTime();
    result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
  }

  if (opts.status) {
    if (opts.status === 'unreviewed') {
      result = result.filter((e) => !e.evaluation?.status);
    } else {
      result = result.filter((e) => e.evaluation?.status === opts.status);
    }
  }

  if (opts.botId) {
    result = result.filter((e) => e.botId === opts.botId);
  }

  return result;
}

/**
 * Sort entries by timestamp.
 *
 * order='desc' (default) is newest first; 'asc' is oldest first.
 * Pure. Returns a new array; does not mutate input.
 */
export function sortByTimestamp(
  entries: ProductionEntry[],
  order: 'asc' | 'desc' = 'desc'
): ProductionEntry[] {
  const copy = [...entries];
  const cmp = order === 'desc'
    ? (a: ProductionEntry, b: ProductionEntry) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    : (a: ProductionEntry, b: ProductionEntry) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  return copy.sort(cmp);
}

/**
 * Filter entries with evaluation.status === 'approved'.
 * Pure. Returns a new array.
 */
export function filterApproved(entries: ProductionEntry[]): ProductionEntry[] {
  return entries.filter((e) => e.evaluation?.status === 'approved');
}

/**
 * Filter entries with evaluation.status === 'rejected'.
 * Pure. Returns a new array.
 */
export function filterRejected(entries: ProductionEntry[]): ProductionEntry[] {
  return entries.filter((e) => e.evaluation?.status === 'rejected');
}

/**
 * Compute aggregate stats from a list of entries.
 *
 * Returns:
 *   total       — number of entries
 *   approved    — entries with evaluation.status === 'approved'
 *   rejected    — entries with evaluation.status === 'rejected'
 *   unreviewed  — entries with no evaluation.status
 *   checked     — entries with coherenceCheck set
 *   avgRating   — average rating (rounded to 1 decimal) across approved +
 *                 rejected entries that have a rating; null if no ratings
 */
export function getStatsFromEntries(entries: ProductionEntry[]): {
  total: number;
  approved: number;
  rejected: number;
  unreviewed: number;
  checked: number;
  avgRating: number | null;
} {
  let approved = 0;
  let rejected = 0;
  let unreviewed = 0;
  let checked = 0;
  const ratings: number[] = [];

  for (const entry of entries) {
    if (!entry.evaluation?.status) {
      unreviewed++;
    } else if (entry.evaluation.status === 'approved') {
      approved++;
      if (entry.evaluation.rating != null) ratings.push(entry.evaluation.rating);
    } else {
      rejected++;
      if (entry.evaluation.rating != null) ratings.push(entry.evaluation.rating);
    }
    if (entry.coherenceCheck) checked++;
  }

  return {
    total: entries.length,
    approved,
    rejected,
    unreviewed,
    checked,
    avgRating:
      ratings.length > 0
        ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
        : null,
  };
}

/**
 * Serialize entries to JSONL (one JSON object per line, trailing newline).
 * Pure. Returns the string.
 */
export function serializeEntries(entries: ProductionEntry[]): string {
  if (entries.length === 0) return '';
  return `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

/**
 * Read entries from a JSONL file. Returns [] if the file does not exist.
 * I/O.
 */
export function readEntries(changelogPath: string): ProductionEntry[] {
  if (!existsSync(changelogPath)) return [];
  const text = readFileSync(changelogPath, 'utf-8');
  const lines = text.split('\n').filter(Boolean);
  return parseEntries(lines);
}

/**
 * Write entries to a JSONL file (overwrites existing content).
 * I/O.
 */
export function writeEntries(changelogPath: string, entries: ProductionEntry[]): void {
  writeFileSync(changelogPath, serializeEntries(entries), 'utf-8');
}

/**
 * Append a single entry to a JSONL file.
 * I/O. Does not create parent directories.
 */
export function appendEntry(changelogPath: string, entry: ProductionEntry): void {
  appendFileSync(changelogPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

/**
 * Append a single entry to a JSONL file.
 * Public API name (preferred at the facade). I/O.
 */
export function append(changelogPath: string, entry: ProductionEntry): void {
  appendEntry(changelogPath, entry);
}

// ---------------------------------------------------------------------------
// Cycle 6 — public API. These functions move out of the facade.
// ---------------------------------------------------------------------------

/**
 * Load a bot's changelog with optional since/status/limit/offset filters.
 * Returns the entries sorted newest-first.
 * I/O.
 */
export function loadChangelog(
  dir: string,
  opts?: { since?: string; status?: string; limit?: number; offset?: number }
): ProductionEntry[] {
  const changelogPath = join(dir, 'changelog.jsonl');
  let entries = readEntries(changelogPath);
  if (entries.length === 0) return [];

  entries = filterEntries(entries, { since: opts?.since, status: opts?.status });
  entries = sortByTimestamp(entries, 'desc');

  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 100;
  return entries.slice(offset, offset + limit);
}

/**
 * Load a single entry by id. Returns null if not found.
 * I/O.
 */
export function loadEntry(dir: string, id: string): ProductionEntry | null {
  const changelogPath = join(dir, 'changelog.jsonl');
  const entries = readEntries(changelogPath);
  return entries.find((e) => e.id === id) ?? null;
}

/**
 * Compute stats over a list of entries.
 * Pure: same as getStatsFromEntries, exposed under the public API name.
 */
export function loadStats(entries: ProductionEntry[]): {
  total: number;
  approved: number;
  rejected: number;
  unreviewed: number;
  checked: number;
  avgRating: number | null;
} {
  return getStatsFromEntries(entries);
}

/**
 * Load entries from multiple bot directories, filter, sort.
 * I/O. Skips missing directories. No limit/offset — the caller slices.
 */
export function loadAllEntries(
  dirs: string[],
  opts?: { since?: string; status?: string; botId?: string }
): ProductionEntry[] {
  let all: ProductionEntry[] = [];
  for (const dir of dirs) {
    const changelogPath = join(dir, 'changelog.jsonl');
    all.push(...readEntries(changelogPath));
  }

  all = filterEntries(all, {
    since: opts?.since,
    status: opts?.status,
    botId: opts?.botId,
  });

  return sortByTimestamp(all, 'desc');
}

/**
 * Read a single entry, mutate it via the mutator, write the file back.
 * Returns the mutated entry, or null if the entry was not found.
 * I/O.
 */
export function updateEntry(
  dir: string,
  id: string,
  mutator: (entry: ProductionEntry) => void
): ProductionEntry | null {
  const changelogPath = join(dir, 'changelog.jsonl');
  const entries = readEntries(changelogPath);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;

  mutator(entries[idx]);
  writeEntries(changelogPath, entries);
  return entries[idx];
}

/**
 * Remove a single entry by id. Returns the removed entry, or null if
 * not found. I/O. Companion to `updateEntry` for the deletion case.
 */
export function removeEntry(dir: string, id: string): ProductionEntry | null {
  const changelogPath = join(dir, 'changelog.jsonl');
  const entries = readEntries(changelogPath);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;

  const [removed] = entries.splice(idx, 1);
  writeEntries(changelogPath, entries);
  return removed;
}

/**
 * Remove entries whose path matches `relativePath` (exact match) or
 * starts with `${relativePath}/` (directory case). Returns the count
 * removed. I/O.
 */
export function removeEntriesByPath(dir: string, relativePath: string): number {
  const changelogPath = join(dir, 'changelog.jsonl');
  if (!existsSync(changelogPath)) return 0;

  const entries = readEntries(changelogPath);
  const prefix = `${relativePath}/`;
  let removed = 0;
  const remaining = entries.filter((e) => {
    const match = e.path === relativePath || e.path.startsWith(prefix);
    if (match) removed++;
    return !match;
  });
  if (removed > 0) writeEntries(changelogPath, remaining);
  return removed;
}

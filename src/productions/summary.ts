/**
 * Summary — bot summary JSON read/write.
 *
 * Extracts readSummary and writeSummary from ProductionsService. Per
 * docs/architecture-docs/productions-refactor.md §4 C3.
 *
 * Module boundary:
 *   - Pure functions on a directory path. No state, no Config, no
 *     ProductionsService.
 *   - Reads/writes a single file (`summary.json`) at the given dir.
 *   - `readSummary` is tolerant: missing file, missing dir, corrupt JSON
 *     all return null (no throw).
 *   - `writeSummary` overwrites the file with pretty-printed JSON.
 *
 * The `plan` field that older versions of this module wrote has been
 * removed: the LLM generation that produced it has been removed too.
 * See docs/architecture-docs/productions-refactor.md §4 C3 + §11.
 *
 * Consumed by ProductionsService (via thin wrappers) and by tests
 * (tests/productions/summary.test.ts).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SummaryData } from './types';

/**
 * The path to the summary file inside a bot's production directory.
 * Single source of truth; the route handler and the service both use
 * `join(dir, 'summary.json')`.
 */
export const SUMMARY_FILENAME = 'summary.json';

/**
 * Read and parse `summary.json` from `dir`.
 *
 * Returns null in all error cases:
 *   - the directory does not exist
 *   - the file does not exist
 *   - the file contains invalid JSON
 *   - the file system is unreadable
 *
 * Forward compatibility: extra fields beyond SummaryData are preserved
 * in the returned object (the parser does not strip unknown keys).
 */
export function readSummary(dir: string): SummaryData | null {
  const summaryPath = join(dir, SUMMARY_FILENAME);
  try {
    if (!existsSync(summaryPath)) return null;
    return JSON.parse(readFileSync(summaryPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write `data` to `summary.json` in `dir`.
 *
 * Overwrites any existing file. Pretty-prints with 2-space indent.
 * Creates the directory if it does not exist (delegated to the caller
 * via the directory's own write — JSON.stringify cannot fail on the
 * shape that SummaryData guarantees).
 */
export function writeSummary(dir: string, data: SummaryData): void {
  writeFileSync(join(dir, SUMMARY_FILENAME), JSON.stringify(data, null, 2), 'utf-8');
}

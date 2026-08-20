/**
 * Paths — directory resolution and traversal guards.
 *
 * Single source of truth for bot production directory resolution and
 * path-containment validation. Per
 * docs/architecture-docs/productions-refactor.md §4 C1.
 *
 * Module boundary:
 *   - Pure functions on Config. No I/O beyond mkdirSync in resolveDir.
 *   - No mutation of Config.
 *   - No dependencies on ProductionsService or other modules.
 *
 * Consumed by ProductionsService (via this module) and by tests
 * (tests/productions/paths.test.ts).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Config } from '../config';

/**
 * Files/dirs excluded from index.html generation.
 *
 * Pin: tests/productions/paths.test.ts → `INDEX_EXCLUDES`.
 * Consumed by Cycle 4 (html.ts) and the renumberFile logic in Cycle 5.
 */
export const INDEX_EXCLUDES = new Set([
  'changelog.jsonl',
  'summary.json',
  'INDEX.md',
  'index.html',
  '.gitignore',
  'node_modules',
  'venv',
  '.vercel',
  '.git',
]);

/**
 * Files/dirs excluded from tree display.
 *
 * Pin: tests/productions/paths.test.ts → `TREE_EXCLUDES`.
 * Consumed by Cycle 7 (tree.ts).
 * Note: `index.html` is NOT excluded — the tree is regenerated and the
 * new index is in the tree before it's moved into place.
 */
export const TREE_EXCLUDES = new Set([
  'changelog.jsonl',
  'summary.json',
  '.gitignore',
  'node_modules',
  'venv',
  '.vercel',
  '.git',
]);

/**
 * Assert that a relative path stays within a directory.
 *
 * Returns true if the resolved path is inside `dir` or `relativePath` is
 * `dir` itself; false otherwise. Handles the four classes of bad input:
 *
 *   1. Absolute paths (POSIX /etc/passwd, Windows D:/x).
 *   2. Leading `..` segments (../../etc/passwd).
 *   3. Single `..` segment (../outside.md).
 *   4. Prefix-sibling bypass (../bot10/safe.md against /prod/bot1).
 *
 * Filenames that *contain* `..` as a substring (e.g. `..file.md`,
 * `my..file.md`) are correctly accepted — the check is segment-aware.
 *
 * Cycle 0.5 (this file): the function lives in paths.ts. Cycle 1 of
 * the original plan moved it here from service.ts. Per the §4 C0.5
 * implementation, the absolute-path guard is `isAbsolute(relativePath)`
 * at the top of the function — `path.join` folds a leading slash before
 * `relative()` ever sees it, so the guard has to be on the input.
 */
export function assertWithinDir(dir: string, relativePath: string): boolean {
  if (isAbsolute(relativePath)) return false;
  const full = resolve(join(dir, relativePath));
  const rel = relative(dir, full);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith('..' + sep)) return false;
  return true;
}

/**
 * Resolve the production directory for a bot.
 *
 * Priority: explicit productions.dir > botConfig.workDir (tenant-resolved)
 * > default `{baseDir}/{botId}`. Creates the directory if it does not exist.
 */
export function resolveDir(config: Config, botId: string): string {
  const baseDir = resolve(config.productions.baseDir);
  const botConfig = config.bots.find((b) => b.id === botId);
  const dir = botConfig?.productions?.dir ?? botConfig?.workDir ?? join(baseDir, botId);
  const resolved = resolve(dir);
  if (!existsSync(resolved)) {
    mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/**
 * Is the bot configured to track files in their natural location
 * (trackOnly: true)?
 */
export function isTrackOnly(config: Config, botId: string): boolean {
  const botConfig = config.bots.find((b) => b.id === botId);
  return botConfig?.productions?.trackOnly ?? false;
}

/**
 * Is the productions feature enabled for this bot?
 *
 * Returns false if global productions.enabled is false OR if the bot's
 * productions.enabled is explicitly false. Returns true otherwise.
 */
export function isEnabled(config: Config, botId: string): boolean {
  if (!config.productions.enabled) return false;
  const botConfig = config.bots.find((b) => b.id === botId);
  return botConfig?.productions?.enabled !== false;
}

/**
 * Resolve a production entry's file path and validate it stays within
 * the bot's production dir.
 *
 * Returns null if the path escapes the boundary (path traversal).
 * `trackOnly` entries are allowed to reference paths outside the
 * production dir — they are by design tracked in their natural location.
 */
export function resolveFilePath(
  dir: string,
  entry: { path: string; trackOnly?: boolean }
): string | null {
  if (entry.trackOnly) return resolve(entry.path);
  if (!assertWithinDir(dir, entry.path)) return null;
  return resolve(join(dir, entry.path));
}

/**
 * Files — file I/O on the production directory (no JSONL, no rebuild).
 *
 * Extracts getFileContent, updateContent, getNextNumber, renumberFile,
 * and a new pure form of archiveFile from ProductionsService. Per
 * docs/architecture-docs/productions-refactor.md §4 C5 + C3.
 *
 * Module boundary:
 *   - Functions take a narrow context object: `{ dir }` (the resolved
 *     production directory). No Config, no logger, no ProductionsService.
 *   - archiveFile is C3's pure form: validates the path, moves the file,
 *     returns { ok, entry }. Does NOT append to JSONL. Does NOT call
 *     rebuildIndex. The facade (ProductionsService.archiveFile)
 *     composes the side effects: appendEntry(dir, entry) +
 *     rebuildIndexPure(botId, dir, soulDir).
 *
 * Consumed by ProductionsService (via thin wrappers) and by tests
 * (tests/productions/files.test.ts).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertWithinDir, INDEX_EXCLUDES } from './paths';
import type { ProductionEntry } from './types';

/** Narrow context for files.ts functions. */
export interface FileContext {
  /** The resolved production directory (absolute path). */
  dir: string;
}

/**
 * Archive a production file by moving it to `archived/<basename>`.
 *
 * PURE per C3: moves the file and returns the entry that the caller
 * should persist. Does NOT write to JSONL, does NOT call rebuildIndex.
 * The facade composes:
 *   - appendEntry(dir, entry)
 *   - rebuildIndexPure(botId, dir, soulDir)
 *
 * Returns:
 *   - { ok: true, entry } on success
 *   - { ok: false } on missing file, path traversal, or rename error
 */
export function archiveFile(
  ctx: FileContext,
  relativePath: string,
  reason: string,
): { ok: true; entry: ProductionEntry } | { ok: false; error?: string } {
  if (!assertWithinDir(ctx.dir, relativePath)) {
    return { ok: false };
  }

  const srcPath = join(ctx.dir, relativePath);
  if (!existsSync(srcPath)) {
    return { ok: false };
  }

  // Create archived/ if needed
  const archivedDir = join(ctx.dir, 'archived');
  if (!existsSync(archivedDir)) {
    mkdirSync(archivedDir, { recursive: true });
  }

  const fileName = basename(relativePath);
  const destPath = join(archivedDir, fileName);

  try {
    renameSync(srcPath, destPath);
  } catch {
    return { ok: false };
  }

  const entry: ProductionEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    botId: '', // Pure function has no Config — facade fills this in
    tool: 'archive',
    path: `archived/${fileName}`,
    action: 'archive',
    description: reason,
    size: 0,
    trackOnly: false,
    archivedFrom: relativePath,
    archiveReason: reason,
  };

  return { ok: true, entry };
}

/**
 * Read a file at a relative path within the production directory.
 *
 * Returns { content, size } when the file exists at a path within the
 * directory; returns null otherwise (including path traversal).
 */
export function getFileContent(
  ctx: FileContext,
  relativePath: string,
): { content: string; size: number } | null {
  if (!assertWithinDir(ctx.dir, relativePath)) return null;

  const fullPath = join(ctx.dir, relativePath);
  try {
    if (!existsSync(fullPath)) return null;
    const stat = statSync(fullPath);
    const content = readFileSync(fullPath, 'utf-8');
    return { content, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * Write content to a file at a relative path within the production dir.
 *
 * Returns true on success, false on path traversal or write error.
 * Creates parent directories as needed.
 */
export function updateContent(ctx: FileContext, relativePath: string, content: string): boolean {
  if (!assertWithinDir(ctx.dir, relativePath)) return false;

  const filePath = join(ctx.dir, relativePath);
  try {
    const fileDir = join(filePath, '..');
    if (!existsSync(fileDir)) mkdirSync(fileDir, { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the next auto-number for files in a given subdirectory.
 *
 * Scans existing files for `^\d{2}_` pattern and returns the next
 * number as a zero-padded string. Returns "01" when the directory is
 * empty or doesn't exist.
 */
export function getNextNumber(ctx: FileContext, relativeDir: string): string {
  // Defense-in-depth: reject traversal/absolute paths (review-4 R1).
  if (relativeDir && !assertWithinDir(ctx.dir, relativeDir)) {
    return '01';
  }

  const targetDir = relativeDir ? join(ctx.dir, relativeDir) : ctx.dir;

  if (!existsSync(targetDir)) {
    return '01';
  }

  let maxNum = 0;
  try {
    const entries = readdirSync(targetDir);
    for (const entry of entries) {
      const match = entry.match(/^(\d{2})_/);
      if (match) {
        const num = Number.parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  } catch {
    return '01';
  }

  return String(maxNum + 1).padStart(2, '0');
}

/**
 * Rename a file on disk to prepend the next auto-number.
 *
 * Returns the new relative path. Skips if already numbered or if file
 * is in INDEX_EXCLUDES. Returns the input path unchanged on missing
 * source or rename error.
 */
export function renumberFile(ctx: FileContext, relativePath: string): string {
  // Defense-in-depth: reject traversal/absolute paths (review-4 R1).
  if (!assertWithinDir(ctx.dir, relativePath)) return relativePath;

  const fileName = basename(relativePath);

  if (INDEX_EXCLUDES.has(fileName)) return relativePath;
  if (/^\d{2}_/.test(fileName)) return relativePath;

  const relDir = dirname(relativePath) === '.' ? '' : dirname(relativePath);
  const nextNum = getNextNumber(ctx, relDir);
  const numberedName = `${nextNum}_${fileName}`;
  const newRelPath = relDir ? `${relDir}/${numberedName}` : numberedName;

  const srcPath = join(ctx.dir, relativePath);
  const destPath = join(ctx.dir, newRelPath);

  if (!existsSync(srcPath)) return relativePath;

  try {
    renameSync(srcPath, destPath);
    return newRelPath;
  } catch {
    return relativePath;
  }
}

/**
 * Count the files in a directory tree (recursively).
 * Returns 0 when the directory does not exist.
 * I/O.
 */
export function countFilesInDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFilesInDir(join(dir, entry.name));
    else count++;
  }
  return count;
}

/**
 * fs-safe — the only module in src/hygiene that mutates the filesystem.
 *
 * - `backupFile` mirrors the `backupSoulFile` convention from src/soul.ts
 *   (`<dir>/.versions/<name>.<ISO>.bak`) but returns the backup path and never
 *   prunes: hygiene routines must not delete anything, not even old backups.
 * - `TrashBatch` moves paths into `<dataDir>/_trash/<stamp>/<relative path>`
 *   and writes a manifest.json so the move can be reverted by hand.
 * - `isWithinRoot` / `assertWithinRoots` mirror `isPathWithinTenant`
 *   (src/tenant/tenant-paths.ts) and `assertWithinDir` (src/productions/paths.ts).
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Logger } from '../logger';

/** True when `path` is `root` itself or lives beneath it. */
export function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Throws unless `path` is inside at least one of `roots`. */
export function assertWithinRoots(path: string, roots: string[]): void {
  if (roots.some((root) => isWithinRoot(path, root))) return;
  throw new Error(`Refusing to touch path outside allowed roots: ${path}`);
}

function isoStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, '');
}

/**
 * Copy `filepath` to `<dir>/.versions/<name>.<ISO>.bak`.
 * Returns the backup path, or null when the source does not exist or the copy failed.
 */
export function backupFile(
  filepath: string,
  logger: Logger,
  now: Date = new Date()
): string | null {
  if (!existsSync(filepath)) return null;

  const versionsDir = join(dirname(filepath), '.versions');
  mkdirSync(versionsDir, { recursive: true });

  const base = `${basename(filepath)}.${isoStamp(now)}`;
  let backupPath = join(versionsDir, `${base}.bak`);
  for (let n = 1; existsSync(backupPath); n++) {
    backupPath = join(versionsDir, `${base}-${n}.bak`);
  }

  try {
    copyFileSync(filepath, backupPath);
    logger.debug({ filepath, backupPath }, 'Soul file backed up');
    return backupPath;
  } catch (err) {
    logger.warn({ err, filepath }, 'Failed to back up soul file');
    return null;
  }
}

/** `YYYY-MM-DDTHH-mm-ss` (UTC) — safe on every filesystem. */
export function trashBatchStamp(date: Date): string {
  return isoStamp(date);
}

export interface TrashManifestEntry {
  from: string;
  to: string;
  relativePath: string;
  reason: string;
  movedAt: string;
}

/**
 * One apply run's worth of trash moves. Nothing is deleted: paths are renamed
 * (or copied+removed across devices) into the batch directory and listed in
 * `manifest.json`.
 */
export class TrashBatch {
  private readonly batchDir: string;
  private readonly entries: TrashManifestEntry[] = [];

  constructor(
    dataDir: string,
    private readonly allowedRoots: string[],
    private readonly now: Date,
    private readonly logger: Logger
  ) {
    this.batchDir = join(resolve(dataDir), '_trash', trashBatchStamp(now));
  }

  get dir(): string {
    return this.batchDir;
  }

  /** Move `absPath` to `<batch>/<relativePath>`. Returns the destination. */
  move(absPath: string, relativePath: string, reason: string): string {
    const src = resolve(absPath);
    assertWithinRoots(src, this.allowedRoots);
    if (!existsSync(src)) throw new Error(`Cannot trash missing path: ${src}`);

    const dest = resolve(join(this.batchDir, relativePath));
    if (!isWithinRoot(dest, this.batchDir) || dest === this.batchDir) {
      throw new Error(`Refusing to trash to a path outside the batch dir: ${relativePath}`);
    }

    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(src, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV') throw err;
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    }

    this.entries.push({
      from: src,
      to: dest,
      relativePath,
      reason,
      movedAt: this.now.toISOString(),
    });
    this.logger.info({ from: src, to: dest, reason }, 'Hygiene moved path to _trash');
    return dest;
  }

  /** Write manifest.json. No-op when nothing was moved. */
  finalize(): TrashManifestEntry[] {
    if (this.entries.length === 0) return [];
    mkdirSync(this.batchDir, { recursive: true });
    writeFileSync(
      join(this.batchDir, 'manifest.json'),
      JSON.stringify({ createdAt: this.now.toISOString(), entries: this.entries }, null, 2),
      'utf-8'
    );
    return this.entries;
  }
}

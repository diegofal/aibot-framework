/**
 * Filesystem <-> archive glue: walking a directory into tar entries, writing a
 * subtree of an extracted archive back to disk, and checksums.
 *
 * Everything here speaks the archive's POSIX path convention. Host paths are
 * only ever produced by `join()` at the last moment, so a bundle built on
 * Windows restores correctly on Linux and vice versa.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type TarArchive,
  type TarEntry,
  isSafeArchivePath,
  normalizeArchivePath,
} from './tar-archive';

export interface WalkOptions {
  /**
   * Return false to skip an entry. `relativePath` is POSIX and relative to the
   * walk root (not including `archivePrefix`), so filters are independent of
   * where the subtree lands in the bundle.
   */
  filter?: (relativePath: string, isDirectory: boolean) => boolean;
  /** Skip files larger than this. Guards against a stray multi-GB artifact. */
  maxFileBytes?: number;
  /** Called for each file skipped because of `maxFileBytes`. */
  onSkipped?: (relativePath: string, reason: string) => void;
}

/**
 * Walk `rootDir` and produce tar entries rooted at `archivePrefix`.
 * Empty directories are emitted explicitly so the restored tree matches.
 */
export function collectDirEntries(
  rootDir: string,
  archivePrefix: string,
  opts: WalkOptions = {}
): TarEntry[] {
  const entries: TarEntry[] = [];
  const prefix = normalizeArchivePath(archivePrefix);

  const walk = (hostDir: string, relativeDir: string): void => {
    let children: string[];
    try {
      children = readdirSync(hostDir);
    } catch {
      return;
    }

    if (children.length === 0 && relativeDir) {
      entries.push({ path: prefix ? `${prefix}/${relativeDir}` : relativeDir });
      return;
    }

    for (const child of children) {
      const hostPath = join(hostDir, child);
      const relativePath = relativeDir ? `${relativeDir}/${child}` : child;

      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(hostPath);
      } catch {
        continue;
      }

      const isDirectory = stats.isDirectory();
      if (opts.filter && !opts.filter(relativePath, isDirectory)) continue;

      if (isDirectory) {
        walk(hostPath, relativePath);
        continue;
      }
      if (!stats.isFile()) continue; // symlinks, sockets, devices: not portable

      if (opts.maxFileBytes !== undefined && stats.size > opts.maxFileBytes) {
        opts.onSkipped?.(relativePath, `exceeds ${opts.maxFileBytes} bytes`);
        continue;
      }

      entries.push({
        path: prefix ? `${prefix}/${relativePath}` : relativePath,
        data: readFileSync(hostPath),
        mtime: stats.mtime,
      });
    }
  };

  walk(rootDir, '');
  return entries;
}

/** Select the part of an extracted archive under `prefix`, with the prefix stripped. */
export function subtree(archive: TarArchive, prefix: string): TarArchive {
  const normalized = normalizeArchivePath(prefix);
  const marker = normalized ? `${normalized}/` : '';
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();

  for (const [path, data] of archive.files) {
    if (!marker || path.startsWith(marker)) files.set(path.slice(marker.length), data);
  }
  for (const path of archive.dirs) {
    if (marker && path.startsWith(marker)) dirs.add(path.slice(marker.length));
  }
  return { files, dirs };
}

/** True when the archive contains anything at all under `prefix`. */
export function hasSubtree(archive: TarArchive, prefix: string): boolean {
  const marker = `${normalizeArchivePath(prefix)}/`;
  for (const path of archive.files.keys()) if (path.startsWith(marker)) return true;
  for (const path of archive.dirs) if (path.startsWith(marker)) return true;
  return false;
}

/** Immediate child directory names under `prefix` (one level deep). */
export function subtreeChildren(archive: TarArchive, prefix: string): string[] {
  const marker = `${normalizeArchivePath(prefix)}/`;
  const names = new Set<string>();
  const collect = (path: string) => {
    if (!path.startsWith(marker)) return;
    const rest = path.slice(marker.length);
    const slash = rest.indexOf('/');
    if (slash > 0) names.add(rest.slice(0, slash));
  };
  for (const path of archive.files.keys()) collect(path);
  for (const path of archive.dirs) collect(path);
  return [...names].sort();
}

/** Write an extracted archive (already prefix-stripped) into `targetDir`. */
export function writeArchiveToDisk(archive: TarArchive, targetDir: string): number {
  mkdirSync(targetDir, { recursive: true });
  for (const dir of archive.dirs) {
    if (!isSafeArchivePath(dir)) throw new Error(`Refusing to create unsafe path: ${dir}`);
    mkdirSync(join(targetDir, ...dir.split('/')), { recursive: true });
  }
  let written = 0;
  for (const [path, data] of archive.files) {
    if (!isSafeArchivePath(path)) throw new Error(`Refusing to write unsafe path: ${path}`);
    const hostPath = join(targetDir, ...path.split('/'));
    mkdirSync(dirname(hostPath), { recursive: true });
    writeFileSync(hostPath, data);
    written++;
  }
  return written;
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * In-memory tar + gzip, with no `tar` binary and no temp-directory staging.
 *
 * The original per-bot exporter shelled out to `tar` and staged files under a
 * hardcoded `/tmp`. Both assumptions break on the platform this framework is
 * actually developed on: `join('/tmp', x)` resolves to `<current drive>\tmp\x`
 * on Windows, and `tar` is only present on Windows 10 1803+ (and absent from
 * slim container images unless explicitly installed). Archiving in memory
 * removes the external dependency, the temp-file cleanup paths, and the
 * partial-write failure modes in one go — export bundles are at most tens of
 * megabytes, which is well inside what a Buffer can hold.
 *
 * Output is POSIX ustar with PAX extended headers for long paths, so GNU tar
 * and bsdtar both read it. The reader accepts ustar, PAX (`x`) and GNU
 * longname (`L`) entries so archives produced by system `tar` import cleanly.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK_SIZE = 512;
const USTAR_NAME_MAX = 100;
const USTAR_PREFIX_MAX = 155;

export interface TarEntry {
  /** POSIX-relative path inside the archive. Never absolute, never `..`. */
  path: string;
  /** File contents. `undefined` marks a directory entry. */
  data?: Buffer;
  mode?: number;
  mtime?: Date;
}

export interface TarArchive {
  files: Map<string, Buffer>;
  dirs: Set<string>;
}

/**
 * Convert a host path fragment to the archive's canonical form: forward
 * slashes, no drive letter, no leading/trailing slash, no `.` segments.
 *
 * Bundles are routinely produced on Windows and unpacked on Linux, so
 * backslashes must never reach the archive — a `soul\IDENTITY.md` entry
 * extracts as a single file literally named `soul\IDENTITY.md` on Linux.
 */
export function normalizeArchivePath(input: string): string {
  const withoutDrive = input.replace(/^[a-zA-Z]:[\\/]/, '');
  const segments = withoutDrive
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.');
  return segments.join('/');
}

/**
 * Reject paths that would escape the extraction root (zip-slip). Import
 * accepts uploaded archives from the dashboard, so this is a trust boundary.
 */
export function isSafeArchivePath(path: string): boolean {
  if (!path) return false;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  return !path.split(/[\\/]+/).includes('..');
}

function writeString(block: Buffer, value: string, offset: number, length: number): void {
  block.write(value.slice(0, length), offset, length, 'utf-8');
}

/** Octal field: `length - 1` zero-padded digits followed by NUL. */
function writeOctal(block: Buffer, value: number, offset: number, length: number): void {
  const digits = Math.max(0, length - 1);
  block.write(value.toString(8).padStart(digits, '0').slice(-digits), offset, digits, 'ascii');
  block[offset + digits] = 0;
}

function checksum(block: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    // The checksum field itself is treated as spaces while summing.
    sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
  }
  return sum;
}

function buildHeader(
  name: string,
  prefix: string,
  size: number,
  typeflag: string,
  mode: number,
  mtime: number
): Buffer {
  const block = Buffer.alloc(BLOCK_SIZE);
  writeString(block, name, 0, 100);
  writeOctal(block, mode, 100, 8);
  writeOctal(block, 0, 108, 8); // uid — always 0; ownership is not portable
  writeOctal(block, 0, 116, 8); // gid
  writeOctal(block, size, 124, 12);
  writeOctal(block, mtime, 136, 12);
  block.write(typeflag, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  writeString(block, prefix, 345, USTAR_PREFIX_MAX);

  const sum = checksum(block);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/**
 * Split a path into ustar `prefix` + `name`. Returns null when no split fits,
 * in which case the caller emits a PAX header instead.
 */
function splitUstarPath(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= USTAR_NAME_MAX) return { name: path, prefix: '' };

  const lastSlash = path.lastIndexOf('/');
  if (lastSlash <= 0) return null;

  const prefix = path.slice(0, lastSlash);
  const name = path.slice(lastSlash + 1);
  if (Buffer.byteLength(name) <= USTAR_NAME_MAX && Buffer.byteLength(prefix) <= USTAR_PREFIX_MAX) {
    return { name, prefix };
  }
  return null;
}

function padToBlock(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

/** PAX record: `"<len> <key>=<value>\n"` where `<len>` counts itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  // The length prefix changes the total length, so converge on a fixed point.
  while (Buffer.byteLength(String(length)) + Buffer.byteLength(body) !== length) {
    length = Buffer.byteLength(String(length)) + Buffer.byteLength(body);
  }
  return Buffer.from(`${length}${body}`, 'utf-8');
}

/** Build an uncompressed tar from in-memory entries. */
export function packTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    const path = normalizeArchivePath(entry.path);
    if (!path) continue;
    if (!isSafeArchivePath(path)) {
      throw new Error(`Refusing to archive unsafe path: ${entry.path}`);
    }

    const isDir = entry.data === undefined;
    const data = entry.data ?? Buffer.alloc(0);
    const archivePath = isDir ? `${path}/` : path;
    const mode = entry.mode ?? (isDir ? 0o755 : 0o644);
    const mtime = Math.floor((entry.mtime?.getTime() ?? Date.now()) / 1000);

    const split = splitUstarPath(archivePath);
    if (!split) {
      // PAX extended header carries the real path; the ustar name is a stub
      // that only matters to readers that ignore PAX.
      const paxData = paxRecord('path', archivePath);
      chunks.push(
        buildHeader('PaxHeader', '', paxData.length, 'x', 0o644, mtime),
        paxData,
        Buffer.alloc(padToBlock(paxData.length))
      );
      const stub = archivePath.slice(-USTAR_NAME_MAX);
      chunks.push(buildHeader(stub, '', data.length, isDir ? '5' : '0', mode, mtime));
    } else {
      chunks.push(
        buildHeader(split.name, split.prefix, data.length, isDir ? '5' : '0', mode, mtime)
      );
    }

    if (!isDir && data.length > 0) {
      chunks.push(data, Buffer.alloc(padToBlock(data.length)));
    }
  }

  // Two zero blocks terminate the archive.
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

export function packTarGz(entries: TarEntry[]): Buffer {
  return gzipSync(packTar(entries));
}

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf-8');
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const raw = readString(block, offset, length).trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length).toString('utf-8');
    const eq = record.indexOf('=');
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1).replace(/\n$/, ''));
    offset += length;
  }
  return records;
}

/** Parse an uncompressed tar into file contents plus explicit directory entries. */
export function unpackTar(buffer: Buffer): TarArchive {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();

  let offset = 0;
  let pendingPath: string | null = null;

  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;

    // A zero block marks the end of the archive.
    if (header.every((byte) => byte === 0)) break;

    const storedChecksum = readOctal(header, 148, 8);
    if (storedChecksum !== checksum(header)) {
      throw new Error('Corrupt archive: tar header checksum mismatch');
    }

    const size = readOctal(header, 124, 12);
    const typeflag = readString(header, 156, 1) || '0';
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, USTAR_PREFIX_MAX);
    const data = buffer.subarray(offset, offset + size);
    offset += size + padToBlock(size);

    if (typeflag === 'x' || typeflag === 'X') {
      pendingPath = parsePaxRecords(data).get('path') ?? null;
      continue;
    }
    if (typeflag === 'L') {
      pendingPath = data.toString('utf-8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'g') continue; // PAX global header — nothing we honour
    if (typeflag === 'K') continue; // GNU long link name

    const rawPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = null;

    const isDir = typeflag === '5' || rawPath.endsWith('/');
    const path = normalizeArchivePath(rawPath);
    if (!path) continue;
    if (!isSafeArchivePath(path)) {
      throw new Error(`Refusing to extract unsafe path: ${rawPath}`);
    }

    if (isDir) {
      dirs.add(path);
    } else if (typeflag === '0' || typeflag === '\0') {
      files.set(path, Buffer.from(data));
    }
    // Symlinks, hardlinks, devices and FIFOs are silently skipped: nothing the
    // exporter emits needs them, and restoring them from an upload is a risk.
  }

  return { files, dirs };
}

export function unpackTarGz(buffer: Buffer): TarArchive {
  let raw: Buffer;
  try {
    raw = gunzipSync(buffer);
  } catch (err) {
    throw new Error(
      `Not a valid .tar.gz archive (gzip decompression failed): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return unpackTar(raw);
}

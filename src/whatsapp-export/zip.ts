/**
 * Minimal .zip reader for WhatsApp exports (iOS sends `_chat.txt` inside a
 * zip). Stored and deflate entries only; no zip64, no encryption. Inflation
 * is capped so a hostile archive cannot balloon in memory.
 */
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  localOffset: number;
}

function listEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new ZipError('Corrupt zip central directory.');
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.toString('utf-8', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, e: ZipEntry, maxBytes: number): Buffer {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIG) {
    throw new ZipError('Corrupt zip entry.');
  }
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.size > maxBytes) throw new ZipError('The chat inside the zip is too large.');
  if (e.method === 0) return Buffer.from(data);
  if (e.method !== 8) throw new ZipError(`Unsupported zip compression (method ${e.method}).`);
  try {
    return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ZipError('The chat inside the zip is too large.');
    }
    throw new ZipError('Could not decompress the zip.');
  }
}

/** The chat text of an export zip: `_chat.txt`, else the first `.txt` entry. */
export function extractChatText(buf: Buffer, opts: { maxBytes?: number } = {}): string {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const entries = listEntries(buf).filter((e) => !e.name.endsWith('/'));
  const base = (n: string) => n.slice(n.lastIndexOf('/') + 1).toLowerCase();
  const entry =
    entries.find((e) => base(e.name) === '_chat.txt') ??
    entries.find((e) => base(e.name).endsWith('.txt'));
  if (!entry) throw new ZipError('The zip has no chat text file (_chat.txt).');
  return readEntry(buf, entry, maxBytes).toString('utf-8');
}

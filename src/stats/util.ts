/**
 * Small, dependency-free helpers shared by every stats reader.
 *
 * Every filesystem helper here is "safe": a missing, unreadable or malformed
 * file yields an empty value instead of throwing. The dashboard must render
 * on a fresh install where none of the data directories exist yet.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import type { StatsWindow } from './types';

const WINDOW_MS: Record<StatsWindow, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

export function parseWindow(raw: string | undefined | null): StatsWindow {
  return raw === '24h' || raw === '7d' || raw === '30d' ? raw : '7d';
}

export function windowToMs(window: StatsWindow): number {
  return WINDOW_MS[window];
}

export function readJsonlSafe<T = unknown>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  return parseJsonlText<T>(text);
}

export function parseJsonlText<T = unknown>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // malformed line — skip
    }
  }
  return out;
}

export function readJsonSafe<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function statSizeSafe(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function statMtimeSafe(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function existsSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Read at most `maxBytes` from the end of a file. When the read starts in the
 * middle of the file, the partial first line is dropped so callers always see
 * whole lines. Returns '' for a missing file.
 */
export function tailText(path: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return '';
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf-8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Normalise epoch-ms, ISO strings or nothing into an ISO string (or null). */
export function toIso(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === 0 || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parse epoch-ms or ISO into epoch-ms, or null when unparseable. */
export function toMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** YYYY-MM-DD (UTC) for an epoch-ms timestamp. */
export function dateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function maxMs(...values: Array<number | null | undefined>): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && (best === null || v > best)) best = v;
  }
  return best;
}

export function round(value: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

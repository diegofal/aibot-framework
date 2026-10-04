/**
 * Rotation-aware log tailing for the dashboard's live `/ws/logs` stream.
 *
 * pino-roll rotates by writing to numbered siblings (`aibot.log.1`, `.2`, …),
 * so `config.logging.file` — the bare, configured path — can be a frozen file
 * once rotation has happened. Reading or watching that path directly (as the
 * WebSocket handler in server.ts used to) silently stops seeing new log
 * lines forever after the first rotation. This reuses the same
 * newest-file-by-mtime resolution already fixed for the stats reader
 * (src/stats/readers/logs.ts).
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { readLogTail, selectLogFiles } from '../stats/readers/logs';

/** The log file currently being appended to, by mtime. Falls back to the bare path. */
export function resolveActiveLogFile(basePath: string): string {
  return selectLogFiles(basePath)[0] ?? basePath;
}

/** Last `maxLines` of log text, spanning rotated files if the newest one is short. */
export function readLastLinesRotationAware(
  basePath: string,
  maxLines: number,
  maxBytes = 2 * 1024 * 1024
): string[] {
  const text = readLogTail(basePath, maxBytes);
  if (!text) return [];
  return text.trimEnd().split('\n').filter(Boolean).slice(-maxLines);
}

/**
 * Every retained log line, oldest first, spanning all rotated siblings — for
 * the paginated `GET /api/logs` endpoint. `maxBytes` bounds memory use; the
 * default comfortably covers the fleet's configured retention (5 files ×
 * 10 MB, see src/logger.ts fileMaxSize/fileLimit).
 */
export function readAllLogLines(basePath: string, maxBytes = 64 * 1024 * 1024): string[] {
  const text = readLogTail(basePath, maxBytes);
  if (!text) return [];
  return text.trimEnd().split('\n').filter(Boolean);
}

/** Tracks which file is being tailed and how far into it we've read. */
export interface LogTailState {
  path: string | null;
  offset: number;
}

function fileSizeSafe(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Call on every file-watch tick (or poll interval). Returns newly-appended
 * text since the last call, or '' when there's nothing new — never throws.
 *
 * On the very first call, and whenever the active file changes (rotation),
 * tailing starts from the *end* of the (possibly new) file: it never replays
 * a rotated file's pre-existing content, since the "last N lines" history
 * sent on WS connect already covers that.
 */
export function pollLogTail(basePath: string, state: LogTailState): string {
  const resolved = resolveActiveLogFile(basePath);

  if (resolved !== state.path) {
    state.path = resolved;
    state.offset = fileSizeSafe(resolved);
    return '';
  }

  const newSize = fileSizeSafe(resolved);
  if (newSize < state.offset) {
    // Truncated (log rotation that reuses the same path, or manual clear).
    state.offset = 0;
  } else if (newSize === state.offset) {
    return '';
  }

  let fd: number | null = null;
  try {
    fd = openSync(resolved, 'r');
    const length = newSize - state.offset;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, state.offset);
    state.offset = newSize;
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed or never opened */
      }
    }
  }
}

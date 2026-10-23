/**
 * The watcher log: `<dir>/YYYY-MM-DD.jsonl`, one row per thing the watcher
 * does, in first-person English written by code. Every row also goes to the
 * pino logger and to `onRow` (the watcher re-emits it as `watcher:log`).
 * In the main log, `sense` rows (one per salient event, the bulk) are at
 * debug and every other phase at info, so the watcher never floods it.
 * Readers never throw; a failed write is a warning, never an exception.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WatcherLogRow, WatcherPhase } from './types';

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface WatcherLogOptions {
  logger?: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    debug?: (obj: object, msg: string) => void;
  };
  now?: () => number;
  onRow?: (row: WatcherLogRow) => void;
}

export type WatcherLogExtra = Omit<WatcherLogRow, 'ts' | 'seq' | 'phase' | 'op' | 'text'>;

export class WatcherLog {
  private seq: number | null = null;
  private readonly now: () => number;

  constructor(
    readonly dir: string,
    private readonly opts: WatcherLogOptions = {}
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Append a row; `ts` and `seq` are stamped here. */
  append(row: Omit<WatcherLogRow, 'ts' | 'seq'> & { ts?: string }): WatcherLogRow {
    const full: WatcherLogRow = {
      ...row,
      ts: row.ts ?? new Date(this.now()).toISOString(),
      seq: this.nextSeq(),
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(
        join(this.dir, `${full.ts.slice(0, 10)}.jsonl`),
        `${JSON.stringify(full)}\n`,
        'utf-8'
      );
    } catch (err) {
      this.opts.logger?.warn({ err }, 'WatcherLog: failed to append row');
    }
    const { text, ...rest } = full;
    if (full.phase === 'sense') this.opts.logger?.debug?.({ watcher: full.op, ...rest }, text);
    else this.opts.logger?.info({ watcher: full.op, ...rest }, text);
    try {
      this.opts.onRow?.(full);
    } catch (err) {
      this.opts.logger?.warn({ err }, 'WatcherLog: onRow listener threw');
    }
    return full;
  }

  /** The one-call helper every module uses. */
  say(phase: WatcherPhase, op: string, text: string, extra: WatcherLogExtra = {}): WatcherLogRow {
    return this.append({ ...extra, phase, op, text });
  }

  /** Rows of one UTC day, newest first; `before` keeps rows with a lower `seq`. */
  read(date: string, opts: { limit?: number; before?: number } = {}): WatcherLogRow[] {
    const rows = this.readDay(date).reverse();
    return page(rows, opts);
  }

  /** The newest rows across days, newest first. */
  recent(limit: number, before?: number): WatcherLogRow[] {
    const out: WatcherLogRow[] = [];
    for (const date of this.dates().reverse()) {
      for (const row of this.readDay(date).reverse()) {
        if (before !== undefined && row.seq >= before) continue;
        out.push(row);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  lastRow(): WatcherLogRow | undefined {
    return this.recent(1)[0];
  }

  /** Days that have a log file, oldest first. */
  dates(): string[] {
    try {
      if (!existsSync(this.dir)) return [];
      return readdirSync(this.dir)
        .map((name) => DAY_FILE.exec(name)?.[1])
        .filter((d): d is string => !!d)
        .sort();
    } catch {
      return [];
    }
  }

  private readDay(date: string): WatcherLogRow[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const out: WatcherLogRow[] = [];
    try {
      const path = join(this.dir, `${date}.jsonl`);
      if (!existsSync(path)) return [];
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as WatcherLogRow;
          if (row && typeof row.seq === 'number' && typeof row.text === 'string') out.push(row);
        } catch {
          // skip
        }
      }
    } catch {
      return [];
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  private nextSeq(): number {
    if (this.seq === null) {
      const dates = this.dates();
      const last = dates.length > 0 ? this.readDay(dates[dates.length - 1]) : [];
      this.seq = last.reduce((m, r) => Math.max(m, r.seq), 0);
    }
    this.seq += 1;
    return this.seq;
  }
}

function page(rows: WatcherLogRow[], opts: { limit?: number; before?: number }): WatcherLogRow[] {
  const filtered =
    opts.before !== undefined ? rows.filter((r) => r.seq < (opts.before as number)) : rows;
  return filtered.slice(0, opts.limit ?? 200);
}

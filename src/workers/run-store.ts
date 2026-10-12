/**
 * Worker run persistence (plan C9), under `<data>/workers/<botId>/`:
 * - `runs.json` — the bot's active runs (atomic tmp + rename, synchronous so
 *   shutdown can persist `interrupted` before the process exits);
 * - `<runId>.jsonl` — the run's append-only journal (`JournalEntry`);
 * - `runs-YYYY-MM-DD.jsonl` — ended runs, by the day they ended.
 * Readers never throw: a missing or corrupt file reads as empty.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runJournalPath, workersDir } from './paths';
import { type JournalEntry, type WorkerRun, type WorkerRunView, toRunView } from './types';

const ACTIVE_FILE = 'runs.json';
const ENDED_FILE = /^runs-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface WorkerRunStoreOptions {
  onError?: (err: unknown) => void;
}

export class WorkerRunStore {
  constructor(
    readonly dataDir: string,
    private readonly opts: WorkerRunStoreOptions = {}
  ) {}

  dir(botId: string): string {
    return workersDir(this.dataDir, botId);
  }

  /** Bots that have a workers dir (any run ever). */
  listBots(): string[] {
    try {
      const root = join(this.dataDir, 'workers');
      if (!existsSync(root)) return [];
      return readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (err) {
      this.opts.onError?.(err);
      return [];
    }
  }

  loadActive(botId: string): WorkerRun[] {
    try {
      const path = join(this.dir(botId), ACTIVE_FILE);
      if (!existsSync(path)) return [];
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { runs?: unknown };
      return Array.isArray(parsed.runs) ? (parsed.runs as WorkerRun[]) : [];
    } catch (err) {
      this.opts.onError?.(err);
      return [];
    }
  }

  /** Replace the bot's active runs (synchronous, atomic). */
  saveActive(botId: string, runs: WorkerRun[]): void {
    const dir = this.dir(botId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, ACTIVE_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, runs }, null, 2)}\n`, 'utf-8');
    renameSync(tmp, path);
  }

  appendJournal(botId: string, runId: string, entry: JournalEntry): void {
    try {
      mkdirSync(this.dir(botId), { recursive: true });
      appendFileSync(runJournalPath(this.dataDir, botId, runId), `${JSON.stringify(entry)}\n`);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  readJournal(botId: string, runId: string): JournalEntry[] {
    return readJsonl<JournalEntry>(runJournalPath(this.dataDir, botId, runId), this.opts.onError);
  }

  /** Append an ended run to the log of the day it ended (claim token dropped). */
  appendEnded(run: WorkerRun): void {
    try {
      const day = (run.endedAt ?? new Date().toISOString()).slice(0, 10);
      mkdirSync(this.dir(run.botId), { recursive: true });
      appendFileSync(
        join(this.dir(run.botId), `runs-${day}.jsonl`),
        `${JSON.stringify(toRunView(run))}\n`
      );
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /** Ended runs, newest first (by `endedAt`), reading the most recent day files first. */
  readEnded(botId: string, opts: { limit?: number; days?: number } = {}): WorkerRunView[] {
    const limit = opts.limit ?? 20;
    const days = opts.days ?? 14;
    let files: string[];
    try {
      const dir = this.dir(botId);
      if (!existsSync(dir)) return [];
      files = readdirSync(dir)
        .filter((f) => ENDED_FILE.test(f))
        .sort()
        .reverse()
        .slice(0, days);
    } catch (err) {
      this.opts.onError?.(err);
      return [];
    }
    const out: WorkerRunView[] = [];
    for (const f of files) {
      const rows = readJsonl<WorkerRunView>(join(this.dir(botId), f), this.opts.onError);
      out.push(...rows);
      if (out.length >= limit * 2) break;
    }
    // A run retried the same day appears once per attempt; keep the last row per run.
    const byId = new Map<string, WorkerRunView>();
    for (const r of out) byId.set(r.runId, r);
    return [...byId.values()]
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
      .slice(0, limit);
  }
}

function readJsonl<T>(path: string, onError?: (err: unknown) => void): T[] {
  try {
    if (!existsSync(path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // malformed line: skipped
      }
    }
    return out;
  } catch (err) {
    onError?.(err);
    return [];
  }
}

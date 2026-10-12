import { abortErrorFrom } from './abort';

/**
 * Process-wide limiter on Claude CLI processes (plan C17).
 *
 * Every Claude CLI call spawns a process plus an MCP bridge; cycles,
 * conversations, feedback, curiosity and (later) task workers all go through
 * `claudeGenerate` / `claudeGenerateWithTools`, which acquire a slot here.
 * Waiters are served by priority (`interactive` > `loop` > `worker`), FIFO
 * within a priority. A waiter whose signal aborts leaves the queue and rejects
 * with `LLMAbortedError`.
 */
export type CliPriority = 'interactive' | 'loop' | 'worker';

export const DEFAULT_CLAUDE_CLI_MAX_CONCURRENT = 3;

const PRIORITY_RANK: Record<CliPriority, number> = { interactive: 0, loop: 1, worker: 2 };

export interface CliSemaphoreStats {
  limit: number;
  active: number;
  queued: number;
  queuedByPriority: Record<CliPriority, number>;
  activeByPriority: Record<CliPriority, number>;
}

interface Waiter {
  priority: CliPriority;
  seq: number;
  grant: () => void;
}

/** Releases the slot. Idempotent. */
export type CliRelease = () => void;

export class CliSemaphore {
  private limit: number;
  private active = 0;
  private activeBy: Record<CliPriority, number> = { interactive: 0, loop: 0, worker: 0 };
  private queue: Waiter[] = [];
  private seq = 0;

  constructor(limit = DEFAULT_CLAUDE_CLI_MAX_CONCURRENT) {
    this.limit = normalizeLimit(limit);
  }

  /** Change the limit at runtime; extra waiters are granted right away when it grows. */
  setLimit(limit: number): void {
    this.limit = normalizeLimit(limit);
    this.drain();
  }

  getLimit(): number {
    return this.limit;
  }

  /**
   * Wait for a slot. Resolves with the release function; rejects with
   * `LLMAbortedError` when `signal` aborts first (already-aborted signals
   * reject without taking a slot).
   */
  acquire(priority: CliPriority = 'loop', signal?: AbortSignal): Promise<CliRelease> {
    if (signal?.aborted) return Promise.reject(abortErrorFrom(signal));
    if (this.active < this.limit && this.queue.length === 0) {
      return Promise.resolve(this.take(priority));
    }
    return new Promise<CliRelease>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        seq: this.seq++,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.take(priority));
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(abortErrorFrom(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.insert(waiter);
    });
  }

  /** Run `fn` while holding a slot. */
  async run<T>(priority: CliPriority, signal: AbortSignal | undefined, fn: () => Promise<T>) {
    const release = await this.acquire(priority, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  stats(): CliSemaphoreStats {
    const queuedByPriority: Record<CliPriority, number> = { interactive: 0, loop: 0, worker: 0 };
    for (const w of this.queue) queuedByPriority[w.priority]++;
    return {
      limit: this.limit,
      active: this.active,
      queued: this.queue.length,
      queuedByPriority,
      activeByPriority: { ...this.activeBy },
    };
  }

  private take(priority: CliPriority): CliRelease {
    this.active++;
    this.activeBy[priority]++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.activeBy[priority]--;
      this.drain();
    };
  }

  private insert(waiter: Waiter): void {
    const rank = PRIORITY_RANK[waiter.priority];
    const at = this.queue.findIndex((w) => PRIORITY_RANK[w.priority] > rank);
    if (at < 0) this.queue.push(waiter);
    else this.queue.splice(at, 0, waiter);
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.grant();
    }
  }
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
}

/** The one limiter every Claude CLI spawn in this process goes through. */
export const claudeCliSemaphore = new CliSemaphore();

/** Apply `claudeCli.maxConcurrent` from config. */
export function configureClaudeCliConcurrency(maxConcurrent: number | undefined): void {
  claudeCliSemaphore.setLimit(maxConcurrent ?? DEFAULT_CLAUDE_CLI_MAX_CONCURRENT);
}

/** Active / queued Claude CLI calls, for the dashboard. */
export function getClaudeCliStats(): CliSemaphoreStats {
  return claudeCliSemaphore.stats();
}

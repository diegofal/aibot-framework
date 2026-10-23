/**
 * Boot and shutdown order around the task worker pool (plan C16).
 *
 * Boot: `recover()` re-binds the claims of interrupted runs **before** the
 * agent loop starts, so the first cycle cannot dispatch the same task twice.
 * Shutdown: `abortAll('shutdown')` persists `interrupted` before the bots stop,
 * bounded to 20 s — compose gives 30 s and a claude-cli step can run 300 s, so
 * waiting for a step to finish is not an option.
 */
import type { Logger } from './logger';
import type { WorkerPoolApi } from './workers/types';

export const SHUTDOWN_ABORT_BOUND_MS = 20_000;

/** The pool through the manager's getter, when the manager has one. */
export function resolveWorkerPool(manager: {
  getWorkerPool?: () => WorkerPoolApi | undefined;
}): WorkerPoolApi | undefined {
  return manager.getWorkerPool?.();
}

export interface StartRuntimeDeps {
  getWorkerPool: () => WorkerPoolApi | undefined;
  startAgentLoop: () => void;
  logger: Logger;
}

/** Recover the pool (never fatal), then start the agent loop. */
export function startRuntime(deps: StartRuntimeDeps): void {
  const pool = deps.getWorkerPool();
  if (pool) {
    try {
      pool.recover();
    } catch (err) {
      deps.logger.error({ err }, 'Worker pool recover failed; starting the agent loop anyway');
    }
  }
  deps.startAgentLoop();
}

export interface ShutdownRuntimeDeps {
  getWorkerPool: () => WorkerPoolApi | undefined;
  stopAll: () => Promise<void>;
  logger: Logger;
  /** Upper bound for `abortAll`; default `SHUTDOWN_ABORT_BOUND_MS`. */
  abortBoundMs?: number;
  /**
   * The fleet watcher's `stop()` (bounded by itself): started first and run
   * alongside the worker abort so the two bounds do not add up within the
   * container's grace period; awaited before returning. Never throws out.
   */
  stopWatcher?: () => Promise<unknown>;
}

/** Stop the watcher alongside aborting every worker run (both bounded, never throw), then stop the bots. */
export async function shutdownRuntime(deps: ShutdownRuntimeDeps): Promise<void> {
  const watcherFailed = (err: unknown) =>
    deps.logger.warn({ err }, 'Watcher failed to stop cleanly');
  let watcher: Promise<unknown> = Promise.resolve();
  try {
    if (deps.stopWatcher) watcher = Promise.resolve(deps.stopWatcher()).catch(watcherFailed);
  } catch (err) {
    watcherFailed(err);
  }
  const pool = deps.getWorkerPool();
  if (pool) {
    const bound = deps.abortBoundMs ?? SHUTDOWN_ABORT_BOUND_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), bound);
    });
    try {
      const outcome = await Promise.race([
        pool.abortAll('shutdown').then(() => 'done' as const),
        timeout,
      ]);
      if (outcome === 'timeout') {
        deps.logger.warn({ boundMs: bound }, 'Worker pool abortAll did not finish in time');
      }
    } catch (err) {
      deps.logger.error({ err }, 'Worker pool abortAll failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  await deps.stopAll();
  await watcher;
}

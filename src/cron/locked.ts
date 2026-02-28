import type { CronServiceState } from './service';

const storeLocks = new Map<string, Promise<void>>();

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (err) => { console.error('[cron/locked] Swallowed chain error:', err); }
  );

export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = state.deps.storePath;
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
  const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(fn);

  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  storeLocks.set(storePath, keepAlive);

  return (await next) as T;
}

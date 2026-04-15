import type { Logger } from '../logger';
import type { CronServiceState } from './service';

const storeLocks = new Map<string, Promise<void>>();

const resolveChain = (promise: Promise<unknown>, logger: Logger) =>
  promise.then(
    () => undefined,
    (err) => {
      logger.error({ err }, '[cron/locked] Swallowed chain error');
    }
  );

export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const { logger, storePath } = state.deps;
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
  const next = Promise.all([resolveChain(state.op, logger), resolveChain(storeOp, logger)]).then(
    fn
  );

  const keepAlive = resolveChain(next, logger);
  state.op = keepAlive;
  storeLocks.set(storePath, keepAlive);

  return (await next) as T;
}

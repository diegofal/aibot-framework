/**
 * Phase 2b (C16): shutdown and boot order around the worker pool.
 *
 * Shutdown: `abortAll('shutdown')` persists `interrupted` before the bots stop,
 * bounded so the 30 s compose grace is never exceeded. Boot: `recover()`
 * re-binds the claims of interrupted runs before the first cycle can dispatch.
 */
import { describe, expect, test } from 'bun:test';
import type { Logger } from '../../src/logger';
import {
  SHUTDOWN_ABORT_BOUND_MS,
  resolveWorkerPool,
  shutdownRuntime,
  startRuntime,
} from '../../src/runtime-lifecycle';
import type { WorkerPoolApi } from '../../src/workers/types';

const logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as unknown as Logger;

function fakePool(overrides: Partial<WorkerPoolApi> = {}): WorkerPoolApi {
  return {
    isEnabledFor: () => true,
    dispatch: () => [],
    list: () => [],
    get: () => null,
    journal: () => [],
    stop: () => false,
    retry: () => ({ taskId: 't', ok: false, reason: 'invalid', message: '' }),
    onAnswer: () => {},
    abortAll: async () => {},
    recover: () => {},
    stats: () => ({ running: 0, queued: 0, waiting: 0, byBot: {} }),
    subscribe: () => () => {},
    ...overrides,
  };
}

describe('startRuntime', () => {
  test('recovers the pool before starting the agent loop', () => {
    const order: string[] = [];
    startRuntime({
      getWorkerPool: () => fakePool({ recover: () => order.push('recover') }),
      startAgentLoop: () => order.push('startAgentLoop'),
      logger,
    });
    expect(order).toEqual(['recover', 'startAgentLoop']);
  });

  test('a failing recover still starts the agent loop', () => {
    const order: string[] = [];
    startRuntime({
      getWorkerPool: () =>
        fakePool({
          recover: () => {
            throw new Error('boom');
          },
        }),
      startAgentLoop: () => order.push('startAgentLoop'),
      logger,
    });
    expect(order).toEqual(['startAgentLoop']);
  });

  test('no pool: just starts the agent loop', () => {
    const order: string[] = [];
    startRuntime({
      getWorkerPool: () => undefined,
      startAgentLoop: () => order.push('startAgentLoop'),
      logger,
    });
    expect(order).toEqual(['startAgentLoop']);
  });
});

describe('shutdownRuntime', () => {
  test('aborts every run with reason shutdown before stopAll', async () => {
    const order: string[] = [];
    await shutdownRuntime({
      getWorkerPool: () =>
        fakePool({
          abortAll: async (reason) => {
            order.push(`abortAll:${reason}`);
          },
        }),
      stopAll: async () => {
        order.push('stopAll');
      },
      logger,
    });
    expect(order).toEqual(['abortAll:shutdown', 'stopAll']);
  });

  test('a hung abortAll is cut at the bound, then stopAll runs', async () => {
    const order: string[] = [];
    const started = Date.now();
    await shutdownRuntime({
      getWorkerPool: () => fakePool({ abortAll: () => new Promise<void>(() => {}) }),
      stopAll: async () => {
        order.push('stopAll');
      },
      logger,
      abortBoundMs: 50,
    });
    expect(order).toEqual(['stopAll']);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a throwing abortAll does not stop the shutdown', async () => {
    const order: string[] = [];
    await shutdownRuntime({
      getWorkerPool: () => fakePool({ abortAll: async () => Promise.reject(new Error('x')) }),
      stopAll: async () => {
        order.push('stopAll');
      },
      logger,
    });
    expect(order).toEqual(['stopAll']);
  });

  test('the default bound is 20 s', () => {
    expect(SHUTDOWN_ABORT_BOUND_MS).toBe(20_000);
  });
});

describe('resolveWorkerPool', () => {
  test('reads getWorkerPool when the manager has it, else undefined', () => {
    const pool = fakePool();
    expect(resolveWorkerPool({ getWorkerPool: () => pool })).toBe(pool);
    expect(resolveWorkerPool({})).toBeUndefined();
  });
});

import { describe, expect, test } from 'bun:test';
import { LLMAbortedError } from '../../src/core/abort';
import { CliSemaphore } from '../../src/core/cli-semaphore';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('CliSemaphore', () => {
  test('grants up to the limit, queues the rest', async () => {
    const sem = new CliSemaphore(2);
    const a = await sem.acquire('loop');
    const b = await sem.acquire('loop');
    let granted = false;
    const c = sem.acquire('loop').then((r) => {
      granted = true;
      return r;
    });
    await tick();
    expect(granted).toBe(false);
    expect(sem.stats()).toMatchObject({ limit: 2, active: 2, queued: 1 });
    a();
    const rc = await c;
    expect(granted).toBe(true);
    expect(sem.stats()).toMatchObject({ active: 2, queued: 0 });
    b();
    rc();
    expect(sem.stats().active).toBe(0);
  });

  test('release is idempotent', async () => {
    const sem = new CliSemaphore(1);
    const r = await sem.acquire();
    r();
    r();
    expect(sem.stats().active).toBe(0);
  });

  test('serves interactive before loop before worker, FIFO within a priority', async () => {
    const sem = new CliSemaphore(1);
    const hold = await sem.acquire('loop');
    const order: string[] = [];
    const wait = (p: 'interactive' | 'loop' | 'worker', tag: string) =>
      sem.acquire(p).then((release) => {
        order.push(tag);
        release();
      });
    const all = Promise.all([
      wait('worker', 'w1'),
      wait('loop', 'l1'),
      wait('interactive', 'i1'),
      wait('loop', 'l2'),
      wait('interactive', 'i2'),
    ]);
    expect(sem.stats().queuedByPriority).toEqual({ interactive: 2, loop: 2, worker: 1 });
    hold();
    await all;
    expect(order).toEqual(['i1', 'i2', 'l1', 'l2', 'w1']);
  });

  test('an aborted waiter leaves the queue and rejects with LLMAbortedError', async () => {
    const sem = new CliSemaphore(1);
    const hold = await sem.acquire();
    const ac = new AbortController();
    const waiting = sem.acquire('loop', ac.signal);
    expect(sem.stats().queued).toBe(1);
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(LLMAbortedError);
    expect(sem.stats().queued).toBe(0);
    hold();
    expect(sem.stats().active).toBe(0);
  });

  test('an already-aborted signal never takes a slot', async () => {
    const sem = new CliSemaphore(1);
    const ac = new AbortController();
    ac.abort();
    await expect(sem.acquire('interactive', ac.signal)).rejects.toBeInstanceOf(LLMAbortedError);
    expect(sem.stats().active).toBe(0);
  });

  test('setLimit grows capacity and grants waiters', async () => {
    const sem = new CliSemaphore(1);
    await sem.acquire();
    const waiting = sem.acquire();
    sem.setLimit(2);
    const r = await waiting;
    expect(sem.stats().active).toBe(2);
    r();
  });

  test('run releases on throw', async () => {
    const sem = new CliSemaphore(1);
    await expect(
      sem.run('loop', undefined, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(sem.stats().active).toBe(0);
  });

  test('invalid limits fall back to 1', () => {
    expect(new CliSemaphore(0).getLimit()).toBe(1);
    expect(new CliSemaphore(Number.NaN).getLimit()).toBe(1);
  });
});

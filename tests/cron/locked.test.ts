import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { locked } from '../../src/cron/locked';
import type { CronServiceState } from '../../src/cron/service';

function createState(): CronServiceState {
  return {
    deps: {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      storePath: '/tmp/test-cron-store',
      cronEnabled: true,
      sendMessage: async () => {},
      resolveSkillHandler: () => undefined,
      nowMs: () => Date.now(),
    },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
  } as CronServiceState;
}

describe('locked()', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('propagates fn() result to caller', async () => {
    const state = createState();
    const result = await locked(state, async () => 42);
    expect(result).toBe(42);
  });

  it('propagates fn() errors to caller', async () => {
    const state = createState();
    await expect(
      locked(state, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });

  it('resolveChain logs errors but does not reject', async () => {
    const state = createState();

    // First call fails — the chain error is swallowed but logged
    try {
      await locked(state, async () => {
        throw new Error('first-fail');
      });
    } catch {
      /* expected */
    }

    // Wait a tick for resolveChain to fire
    await new Promise((r) => setTimeout(r, 10));

    expect(consoleSpy).toHaveBeenCalled();
    const args = consoleSpy.mock.calls.flat();
    expect(args.some((a: unknown) => String(a).includes('Swallowed chain error'))).toBe(true);

    // Second call succeeds — the resolved chain doesn't block it
    const result = await locked(state, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('serializes concurrent calls', async () => {
    const state = createState();
    const order: number[] = [];

    const p1 = locked(state, async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return 'a';
    });

    const p2 = locked(state, async () => {
      order.push(2);
      return 'b';
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('a');
    expect(r2).toBe('b');
    expect(order).toEqual([1, 2]);
  });
});

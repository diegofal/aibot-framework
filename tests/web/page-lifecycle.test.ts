import { describe, expect, it } from 'bun:test';
import { createPageLifecycle } from '../../web/page-lifecycle.js';

describe('createPageLifecycle', () => {
  it('runs the declared destroys of the page being left, once', () => {
    const calls: string[] = [];
    const lc = createPageLifecycle();
    lc.enter([() => calls.push('a'), () => calls.push('b')]);
    lc.leave();
    lc.leave();
    expect(calls).toEqual(['a', 'b']);
  });

  it('runs the always-hooks on every leave', () => {
    const calls: string[] = [];
    const lc = createPageLifecycle({ always: [() => calls.push('always')] });
    lc.leave();
    lc.enter([]);
    lc.leave();
    expect(calls).toEqual(['always', 'always']);
  });

  it('accepts a cleanup function returned by the page handler', () => {
    const calls: string[] = [];
    const lc = createPageLifecycle();
    lc.enter([], () => calls.push('returned'));
    lc.leave();
    expect(calls).toEqual(['returned']);
  });

  it('accepts a cleanup resolved later by an async handler', async () => {
    const calls: string[] = [];
    const lc = createPageLifecycle();
    lc.enter(
      [],
      Promise.resolve(() => calls.push('async'))
    );
    await Promise.resolve();
    await Promise.resolve();
    lc.leave();
    expect(calls).toEqual(['async']);
  });

  it('runs a late async cleanup immediately when the page was already left', async () => {
    const calls: string[] = [];
    let resolve: (fn: () => void) => void = () => {};
    const lc = createPageLifecycle();
    lc.enter(
      [],
      new Promise((r) => {
        resolve = r;
      })
    );
    lc.leave();
    lc.enter([() => calls.push('next page')]);
    resolve(() => calls.push('late'));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['late']);
  });

  it('ignores non-function results and keeps going when a cleanup throws', () => {
    const calls: string[] = [];
    const lc = createPageLifecycle({ onError: () => calls.push('error') });
    lc.enter(
      [
        () => {
          throw new Error('boom');
        },
        () => calls.push('second'),
      ],
      'not a function'
    );
    lc.leave();
    expect(calls).toEqual(['error', 'second']);
  });

  it('ignores a rejected async handler', async () => {
    const lc = createPageLifecycle();
    lc.enter([], Promise.reject(new Error('page failed')));
    await Promise.resolve();
    expect(() => lc.leave()).not.toThrow();
  });
});

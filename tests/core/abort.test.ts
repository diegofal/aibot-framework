import { describe, expect, test } from 'bun:test';
import {
  LLMAbortedError,
  abortErrorFrom,
  isAbort,
  isAbortError,
  raceAbort,
  throwIfAborted,
  toolSignal,
  withTimeoutSignal,
} from '../../src/core/abort';

describe('abort helpers', () => {
  test('LLMAbortedError is recognised by name and instance', () => {
    const err = new LLMAbortedError();
    expect(err.name).toBe('AbortError');
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
  });

  test('a timeout is not an abort', () => {
    expect(isAbortError(new DOMException('t', 'TimeoutError'))).toBe(false);
    expect(isAbortError(new Error('timeout'))).toBe(false);
  });

  test('isAbort is true when the signal is aborted, whatever the error', () => {
    const ac = new AbortController();
    expect(isAbort(new Error('fetch failed'), ac.signal)).toBe(false);
    ac.abort();
    expect(isAbort(new Error('fetch failed'), ac.signal)).toBe(true);
  });

  test('abortErrorFrom keeps the reason', () => {
    const ac = new AbortController();
    ac.abort(new Error('stop pressed'));
    const err = abortErrorFrom(ac.signal);
    expect(err.message).toContain('stop pressed');
    expect((err.reason as Error).message).toBe('stop pressed');
  });

  test('throwIfAborted', () => {
    throwIfAborted(undefined);
    const ac = new AbortController();
    throwIfAborted(ac.signal);
    ac.abort();
    expect(() => throwIfAborted(ac.signal)).toThrow(LLMAbortedError);
  });

  test('withTimeoutSignal aborts on either source', () => {
    const ac = new AbortController();
    const s = withTimeoutSignal(60_000, ac.signal);
    expect(s.aborted).toBe(false);
    ac.abort();
    expect(s.aborted).toBe(true);
  });

  test('raceAbort stops waiting on abort and passes results through otherwise', async () => {
    expect(await raceAbort(Promise.resolve(1))).toBe(1);
    const ac = new AbortController();
    expect(await raceAbort(Promise.resolve(2), ac.signal)).toBe(2);
    const never = new Promise<number>(() => {});
    const raced = raceAbort(never, ac.signal);
    ac.abort();
    await expect(raced).rejects.toBeInstanceOf(LLMAbortedError);
  });

  test('toolSignal reads only a real AbortSignal', () => {
    const ac = new AbortController();
    expect(toolSignal({ _signal: ac.signal })).toBe(ac.signal);
    expect(toolSignal({ _signal: 'nope' })).toBeUndefined();
    expect(toolSignal({})).toBeUndefined();
  });
});

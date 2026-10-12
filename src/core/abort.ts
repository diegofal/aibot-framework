/**
 * Real cancellation for LLM calls and long tools (plan C12).
 *
 * A Stop, a step timeout, shutdown or the cycle `maxDurationMs` race aborts an
 * `AbortSignal`; every layer that sees it rejects with `LLMAbortedError` and
 * every fallback branch checks `isAbortError` / `signal.aborted` first, so an
 * abort never re-issues the call on another model or backend (which would
 * replay the tool loop).
 *
 * `name` is `'AbortError'` on purpose: `runWithModelFallback` and other
 * existing abort checks already rethrow on that name.
 */
export class LLMAbortedError extends Error {
  /** The signal's reason, when the aborter gave one. */
  readonly reason?: unknown;

  constructor(message = 'LLM call aborted', reason?: unknown) {
    super(message);
    this.name = 'AbortError';
    this.reason = reason;
  }
}

/** Build the abort error for a signal, keeping its reason. */
export function abortErrorFrom(signal?: AbortSignal, message?: string): LLMAbortedError {
  const reason = signal?.reason;
  if (reason instanceof LLMAbortedError) return reason;
  const why =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : undefined;
  return new LLMAbortedError(message ?? (why ? `LLM call aborted: ${why}` : undefined), reason);
}

/** Throw `LLMAbortedError` when the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal, message?: string): void {
  if (signal?.aborted) throw abortErrorFrom(signal, message);
}

/**
 * True for an abort: our `LLMAbortedError`, or any error named `AbortError`
 * (a DOMException from `fetch` aborted by the caller's signal). A
 * `TimeoutError` from `AbortSignal.timeout` is deliberately **not** an abort:
 * a per-request timeout may still fall back.
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof LLMAbortedError) return true;
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Whether a failure must skip every fallback: the caller's signal is aborted,
 * or the error itself is an abort.
 */
export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || isAbortError(err);
}

/** The `LLMAbortedError` to rethrow for an abort (keeps an existing one as is). */
export function toAbortError(err: unknown, signal?: AbortSignal): LLMAbortedError {
  if (err instanceof LLMAbortedError) return err;
  return abortErrorFrom(signal);
}

/**
 * Combine the caller's signal with a per-request timeout. Without a caller
 * signal this is exactly `AbortSignal.timeout(ms)` (unchanged behaviour).
 */
export function withTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Race a promise against a signal: resolves/rejects with the promise, or
 * rejects with `LLMAbortedError` as soon as the signal aborts. The underlying
 * work is not cancelled — use this only where the operation has no way to be
 * cancelled ("stop waiting"). Without a signal it returns the promise as is.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortErrorFrom(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(abortErrorFrom(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/** Read the `_signal` the tool executor injects into a tool's args. */
export function toolSignal(args: Record<string, unknown>): AbortSignal | undefined {
  const s = args._signal;
  return s instanceof AbortSignal ? s : undefined;
}

/** Standard result text for a tool stopped by its signal. */
export const TOOL_ABORTED_MESSAGE = 'Stopped: the run was cancelled before this tool finished.';

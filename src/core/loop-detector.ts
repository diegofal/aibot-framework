import { createHash } from 'node:crypto';

export interface LoopDetector {
  recordCall(name: string, args: Record<string, unknown>, result: string): void;
  check(): { action: 'continue' | 'warn' | 'break'; message?: string };
  reset(): void;
}

function hashKey(data: string): string {
  return createHash('md5').update(data).digest('hex');
}

/**
 * Composite loop detector with three strategies:
 * 1. Repeat detector — same tool+args called N times
 * 2. No-progress detector — same tool returns same result
 * 3. Global circuit breaker — total calls exceed threshold
 */
export function createLoopDetector(maxToolRounds: number): LoopDetector {
  const callHashes = new Map<string, number>(); // hash(name+args) → count
  const resultHashes = new Map<string, number>(); // hash(name+result) → count
  let totalCalls = 0;
  const globalLimit = maxToolRounds * 2;

  return {
    recordCall(name: string, args: Record<string, unknown>, result: string): void {
      totalCalls++;

      const callKey = hashKey(name + JSON.stringify(args));
      callHashes.set(callKey, (callHashes.get(callKey) ?? 0) + 1);

      // Hash only first 500 chars of result to avoid expensive hashing
      const resultKey = hashKey(name + result.slice(0, 500));
      resultHashes.set(resultKey, (resultHashes.get(resultKey) ?? 0) + 1);
    },

    check(): { action: 'continue' | 'warn' | 'break'; message?: string } {
      // Global circuit breaker
      if (totalCalls >= globalLimit) {
        return { action: 'break', message: `Exceeded ${globalLimit} total tool calls` };
      }

      // Repeat detector: same call 4+ times → break, 3 times → warn
      for (const [, count] of callHashes) {
        if (count >= 4) {
          return { action: 'break', message: 'Same tool call repeated 4+ times with identical arguments' };
        }
        if (count >= 3) {
          return { action: 'warn', message: 'You appear to be repeating the same tool call. Try a different approach' };
        }
      }

      // No-progress detector: same result 2+ times → warn
      for (const [, count] of resultHashes) {
        if (count >= 3) {
          return { action: 'break', message: 'Same tool returning identical results repeatedly' };
        }
        if (count >= 2) {
          return { action: 'warn', message: 'A tool is returning the same result as before — you may not be making progress' };
        }
      }

      return { action: 'continue' };
    },

    reset(): void {
      callHashes.clear();
      resultHashes.clear();
      totalCalls = 0;
    },
  };
}

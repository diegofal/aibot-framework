import { createHash } from 'node:crypto';

export type LoopBreakDetector = 'global' | 'repeat' | 'no-progress';

export interface LoopCheckResult {
  action: 'continue' | 'warn' | 'break';
  message?: string;
  detector?: LoopBreakDetector;
  totalCalls?: number;
}

export interface LoopDetector {
  recordCall(name: string, args: Record<string, unknown>, result: string): void;
  check(): LoopCheckResult;
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
  // NOTE: maxToolRounds counts LLM *rounds*; totalCalls counts *individual tool calls*.
  // A round with parallel tool calls consumes several. 2x is the safety headroom.
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

    check(): LoopCheckResult {
      // Global circuit breaker
      if (totalCalls >= globalLimit) {
        return {
          action: 'break',
          message: `Exceeded ${globalLimit} total tool calls`,
          detector: 'global',
          totalCalls,
        };
      }

      // Repeat detector: same call 4+ times → break, 3 times → warn
      for (const [, count] of callHashes) {
        if (count >= 4) {
          return {
            action: 'break',
            message: 'Same tool call repeated 4+ times with identical arguments',
            detector: 'repeat',
            totalCalls,
          };
        }
        if (count >= 3) {
          return {
            action: 'warn',
            message: 'You appear to be repeating the same tool call. Try a different approach',
          };
        }
      }

      // No-progress detector: same result 2+ times → warn
      for (const [, count] of resultHashes) {
        if (count >= 3) {
          return {
            action: 'break',
            message: 'Same tool returning identical results repeatedly',
            detector: 'no-progress',
            totalCalls,
          };
        }
        if (count >= 2) {
          return {
            action: 'warn',
            message:
              'A tool is returning the same result as before — you may not be making progress',
          };
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

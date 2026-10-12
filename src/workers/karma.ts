/**
 * Karma per worker run (C22). Subscribed to the pool's events; only
 * `worker:ended` counts:
 * - `protocol` (a step ended without its report tool, or broke the step rules)
 *   → `workerProtocol` (−1 by default, filed under `tool` like a tool error);
 * - `done` with a note → `workerDone` (0 by default: configurable, not paid);
 * - everything else (failed, blocked, budget, stopped, interrupted) → nothing:
 *   tool errors inside the run are already scored by the executor.
 * Never throws.
 */

import type { KarmaOutcomeKind } from '../karma/types';
import type { WorkerEvent } from './types';

export interface WorkerKarmaSink {
  recordOutcome(
    botId: string,
    kind: KarmaOutcomeKind,
    reason: string,
    metadata?: Record<string, unknown>
  ): unknown;
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createWorkerKarmaListener(
  karma: WorkerKarmaSink,
  onError?: (err: unknown) => void
): (event: WorkerEvent) => void {
  return (event) => {
    if (event.type !== 'worker:ended') return;
    const outcome = event.data.outcome;
    if (!outcome) return;
    const note = (outcome.note ?? '').replace(/\s+/g, ' ').trim();
    const metadata = {
      runId: event.data.runId,
      taskId: event.data.taskId,
      goalId: event.data.goalId,
    };
    try {
      if (outcome.kind === 'protocol') {
        karma.recordOutcome(
          event.botId,
          'workerProtocol',
          clip(`Worker broke the step protocol${note ? `: ${note}` : ''}`),
          metadata
        );
      } else if (outcome.kind === 'done' && note) {
        karma.recordOutcome(event.botId, 'workerDone', clip(`Task done: ${note}`), metadata);
      }
    } catch (err) {
      onError?.(err);
    }
  };
}

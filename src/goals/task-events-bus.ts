/**
 * Task change bus — every successful `TaskStore.apply` that wrote something
 * publishes one notice per changed task here (C19 `task:changed`).
 *
 * The store does not know its bot (a soul dir is all it has), so a notice
 * carries the soul dir and the `botId` the creator passed, if any;
 * `forwardTaskChanges` resolves the bot and republishes on the ActivityStream.
 * Listeners never break a write: a throw is swallowed.
 */
import { TASK_CHANGED_EVENT, type TaskChangedData } from '../workers/types';

export interface TaskChangeNotice {
  soulDir: string;
  botId?: string;
  data: TaskChangedData;
}

type Listener = (notice: TaskChangeNotice) => void;

const listeners = new Set<Listener>();

/** Subscribe to task changes from every store in the process. Returns an unsubscribe. */
export function onTaskChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by `TaskStore.apply` after the write landed. */
export function emitTaskChanged(notice: TaskChangeNotice): void {
  for (const l of listeners) {
    try {
      l(notice);
    } catch {
      // A listener never breaks a task write.
    }
  }
}

export interface TaskChangeSink {
  publish(event: {
    type: typeof TASK_CHANGED_EVENT;
    botId: string;
    timestamp: number;
    data: Record<string, unknown>;
  }): void;
}

/**
 * Republish every notice as a `task:changed` ActivityStream event. The bot is
 * the notice's own `botId`, else `resolveBot(soulDir)`; unresolved notices are
 * dropped (the socket filter would hide a bot-less event from tenants anyway).
 */
export function forwardTaskChanges(
  sink: TaskChangeSink,
  resolveBot: (soulDir: string) => string | undefined,
  now: () => number = Date.now
): () => void {
  return onTaskChanged((n) => {
    const botId = n.botId ?? resolveBot(n.soulDir);
    if (!botId) return;
    sink.publish({
      type: TASK_CHANGED_EVENT,
      botId,
      timestamp: now(),
      data: { ...n.data },
    });
  });
}

/**
 * Live per-bot presence derived from the activity stream.
 *
 * The agent loop hands the whole plan to one agentic LLM call, so there is no
 * observable "step 2 of 5"; what *is* observable is the phase the cycle is in
 * (`agent:phase`) and the tool being executed (`tool:start` / `tool:end`).
 * This tracker folds those events into a tiny state per bot that the presence
 * endpoint reads. It never throws and never keeps history.
 */
import type { ActivityEvent } from '../bot/activity-stream';

export interface LivePresence {
  executing: boolean;
  phase: string | null;
  currentTool: string | null;
  /** When the current phase / tool started (ms), null when idle. */
  since: number | null;
}

const IDLE: LivePresence = { executing: false, phase: null, currentTool: null, since: null };

export class PresenceTracker {
  private state = new Map<string, LivePresence>();

  /** Subscribe to an ActivityStream (or anything with the same `on`). */
  attach(stream: { on(event: 'activity', listener: (e: ActivityEvent) => void): unknown }): this {
    stream.on('activity', (e) => this.handle(e));
    return this;
  }

  handle(event: ActivityEvent): void {
    if (!event || typeof event.botId !== 'string') return;
    const cur = this.state.get(event.botId) ?? { ...IDLE };
    const ts = Number(event.timestamp) || Date.now();
    switch (event.type) {
      case 'agent:phase': {
        const phase = typeof event.phase === 'string' ? event.phase : null;
        this.state.set(event.botId, {
          executing: true,
          phase,
          currentTool: phase?.endsWith(':start') || phase === 'start' ? null : cur.currentTool,
          since: ts,
        });
        return;
      }
      case 'tool:start': {
        const name = event.data?.toolName;
        this.state.set(event.botId, {
          executing: true,
          phase: cur.phase ?? 'executor:start',
          currentTool: typeof name === 'string' ? name : null,
          since: ts,
        });
        return;
      }
      case 'tool:end':
      case 'tool:error': {
        if (!cur.executing) return;
        this.state.set(event.botId, { ...cur, currentTool: null, since: ts });
        return;
      }
      case 'agent:result':
      case 'agent:idle': {
        this.state.set(event.botId, { ...IDLE });
        return;
      }
      default:
        return;
    }
  }

  get(botId: string): LivePresence {
    return { ...(this.state.get(botId) ?? IDLE) };
  }

  /** Test / reset helper. */
  clear(botId?: string): void {
    if (botId) this.state.delete(botId);
    else this.state.clear();
  }
}

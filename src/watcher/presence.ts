/**
 * The watcher's own presence tracker (phase 4): what every bot is doing right
 * now (phase, tool, since; live worker runs), from the activity stream. Owned
 * by the watcher so it does not depend on the web server's instance
 * (`src/stats/presence-tracker.ts`); attached on `start()`, detached on
 * `stop()`. A listener that meets a malformed event never throws.
 */
import type { ActivityEvent } from '../bot/activity-stream';
import { type LivePresence, type LiveWorker, PresenceTracker } from '../stats/presence-tracker';

type Listenable = {
  on(event: 'activity', listener: (e: ActivityEvent) => void): unknown;
  off(event: 'activity', listener: (e: ActivityEvent) => void): unknown;
};

export class WatcherPresence {
  private readonly tracker = new PresenceTracker();
  private attached: { stream: Listenable; fn: (e: ActivityEvent) => void } | null = null;

  attach(stream: Listenable): this {
    if (this.attached?.stream === stream) return this;
    this.detach();
    const fn = (e: ActivityEvent) => {
      try {
        this.tracker.handle(e);
      } catch {
        // a malformed event changes nothing
      }
    };
    stream.on('activity', fn);
    this.attached = { stream, fn };
    return this;
  }

  detach(): void {
    if (!this.attached) return;
    this.attached.stream.off('activity', this.attached.fn);
    this.attached = null;
  }

  get(botId: string): LivePresence {
    return this.tracker.get(botId);
  }

  workers(botId: string): LiveWorker[] {
    return this.tracker.workers(botId);
  }
}

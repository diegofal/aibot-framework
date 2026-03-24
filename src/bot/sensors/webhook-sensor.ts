/**
 * WebhookSensor — Receives external HTTP POST events and queues them as stimuli.
 *
 * Events are pushed via `receiveEvent()` from the HTTP route handler
 * and drained by `poll()` during the agent loop cycle.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Sensor, StimulusEvent } from './types';

const MAX_QUEUE_SIZE = 50;

interface QueuedEvent {
  timestamp: number;
  summary: string;
  relevance: number;
  data?: Record<string, unknown>;
}

export class WebhookSensor implements Sensor {
  id = 'webhook';
  /** botId → queued events */
  private queues = new Map<string, QueuedEvent[]>();

  constructor(private secret?: string) {}

  /**
   * Receive an external event (called from HTTP route handler).
   * Returns true if accepted, false if rejected (bad signature, full queue).
   */
  receiveEvent(
    botId: string,
    payload: { summary: string; relevance?: number; data?: Record<string, unknown> },
    signature?: string
  ): boolean {
    // Verify HMAC if secret configured
    if (this.secret) {
      if (!signature) return false;
      const expected = createHmac('sha256', this.secret)
        .update(JSON.stringify(payload))
        .digest('hex');
      const sigBuffer = Buffer.from(signature);
      const expBuffer = Buffer.from(expected);
      if (sigBuffer.length !== expBuffer.length || !timingSafeEqual(sigBuffer, expBuffer)) {
        return false;
      }
    }

    let queue = this.queues.get(botId);
    if (!queue) {
      queue = [];
      this.queues.set(botId, queue);
    }

    if (queue.length >= MAX_QUEUE_SIZE) {
      queue.shift(); // drop oldest
    }

    queue.push({
      timestamp: Date.now(),
      summary: (payload.summary || 'External event').slice(0, 100),
      relevance: Math.min(1.0, Math.max(0.0, payload.relevance ?? 0.5)),
      data: payload.data,
    });

    return true;
  }

  /**
   * Poll drains all queued events for a bot.
   */
  async poll(botId: string): Promise<StimulusEvent[]> {
    const queue = this.queues.get(botId);
    if (!queue || queue.length === 0) return [];

    const events = queue.splice(0).map((e) => ({
      sensorId: this.id,
      timestamp: e.timestamp,
      category: 'external' as const,
      summary: e.summary,
      relevance: e.relevance,
      data: e.data,
    }));

    return events;
  }

  /**
   * Get queue size for a bot (for monitoring).
   */
  getQueueSize(botId: string): number {
    return this.queues.get(botId)?.length ?? 0;
  }
}

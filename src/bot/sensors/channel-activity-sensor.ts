/**
 * ChannelActivitySensor — Reports message activity from session data.
 *
 * Uses a lightweight activity tracker interface rather than directly
 * accessing SessionManager internals.
 */

import type { Sensor, StimulusEvent } from './types';

/**
 * Interface for activity data. Implementations wrap SessionManager
 * or any other source of message count data.
 */
export interface ActivityDataSource {
  /** Get count of active conversations for a bot in the last N hours */
  getActiveCount(botId: string, windowHours: number): number;
  /** Get timestamp of last message sent TO this bot */
  getLastInboundTimestamp(botId: string): number | null;
  /** Get timestamp of last message sent BY this bot */
  getLastOutboundTimestamp(botId: string): number | null;
}

export class ChannelActivitySensor implements Sensor {
  id = 'channel-activity';

  constructor(private dataSource: ActivityDataSource) {}

  async poll(botId: string): Promise<StimulusEvent[]> {
    const windowHours = 6;
    const activeCount = this.dataSource.getActiveCount(botId, windowHours);
    const lastInbound = this.dataSource.getLastInboundTimestamp(botId);
    const lastOutbound = this.dataSource.getLastOutboundTimestamp(botId);

    const now = Date.now();
    const parts: string[] = [];
    let relevance = 0.2;

    if (activeCount > 0) {
      parts.push(
        `${activeCount} active conversation${activeCount > 1 ? 's' : ''} (last ${windowHours}h)`
      );
      relevance = Math.min(0.8, 0.3 + activeCount * 0.1);
    } else {
      parts.push(`No active conversations (last ${windowHours}h)`);
    }

    if (lastInbound) {
      const hoursAgo = Math.round((now - lastInbound) / 3_600_000);
      if (hoursAgo < windowHours) {
        parts.push(`last message received ${hoursAgo}h ago`);
      }
    }

    // Detect response gap: inbound after outbound = unanswered
    if (lastInbound && lastOutbound && lastInbound > lastOutbound) {
      const gapMinutes = Math.round((now - lastInbound) / 60_000);
      if (gapMinutes > 30) {
        parts.push(`⚠️ unanswered message (${gapMinutes}min ago)`);
        relevance = Math.min(0.9, relevance + 0.3);
      }
    }

    return [
      {
        sensorId: this.id,
        timestamp: now,
        category: 'activity',
        summary: parts.join(', ').slice(0, 100),
        relevance,
        data: { activeCount, lastInbound, lastOutbound },
      },
    ];
  }
}

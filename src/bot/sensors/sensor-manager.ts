/**
 * SensorManager — Aggregates, schedules, and budgets environmental sensor output.
 *
 * Collects readings from all configured sensors and produces a formatted
 * environment block for injection into planner/strategist prompts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../../logger';
import { type ActivityDataSource, ChannelActivitySensor } from './channel-activity-sensor';
import { RssSensor } from './rss-sensor';
import { TimeSensor } from './time-sensor';
import type { Sensor, SensorConfig, StimulusEvent } from './types';
import { WebhookSensor } from './webhook-sensor';

const MAX_ENVIRONMENT_CHARS = 500;
const POLL_TIMEOUT_MS = 15_000;

export class SensorManager {
  private sensors: Sensor[] = [];
  /** botId → latest readings cache */
  private cache = new Map<string, StimulusEvent[]>();
  private webhookSensor?: WebhookSensor;
  private dataDir?: string;

  constructor(
    private logger: Logger,
    dataDir?: string
  ) {
    this.dataDir = dataDir;
  }

  /**
   * Initialize sensors from config. Call once per bot or globally.
   */
  configure(config: SensorConfig, activityDataSource?: ActivityDataSource): void {
    this.sensors = [];

    // TimeSensor is always enabled (zero cost)
    if (config.time?.enabled !== false) {
      this.sensors.push(new TimeSensor());
    }

    if (config.rss?.enabled && config.rss.feeds && config.rss.feeds.length > 0) {
      this.sensors.push(new RssSensor(config.rss.feeds));
    }

    if (config.channelActivity?.enabled && activityDataSource) {
      this.sensors.push(new ChannelActivitySensor(activityDataSource));
    }

    if (config.webhook?.enabled) {
      this.webhookSensor = new WebhookSensor(config.webhook.secret);
      this.sensors.push(this.webhookSensor);
    }
  }

  /**
   * Add a custom sensor programmatically.
   */
  addSensor(sensor: Sensor): void {
    this.sensors.push(sensor);
  }

  /**
   * Get the webhook sensor instance (for HTTP route handler to push events).
   */
  getWebhookSensor(): WebhookSensor | undefined {
    return this.webhookSensor;
  }

  /**
   * Poll all sensors, cache results, and persist to disk.
   */
  async pollAll(botId: string): Promise<StimulusEvent[]> {
    const allEvents: StimulusEvent[] = [];

    for (const sensor of this.sensors) {
      try {
        const events = await Promise.race([
          sensor.poll(botId),
          new Promise<StimulusEvent[]>((resolve) => setTimeout(() => resolve([]), POLL_TIMEOUT_MS)),
        ]);
        allEvents.push(...events);
      } catch (err) {
        this.logger.debug({ err, sensorId: sensor.id }, 'Sensor poll failed');
      }
    }

    // Sort by relevance (highest first)
    allEvents.sort((a, b) => b.relevance - a.relevance);
    this.cache.set(botId, allEvents);

    // Persist to disk for dashboard visibility between cycles
    if (this.dataDir && allEvents.length > 0) {
      try {
        const filePath = join(this.dataDir, botId, 'sensors-latest.json');
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, JSON.stringify(allEvents, null, 2), 'utf-8');
      } catch (err) {
        this.logger.debug({ err, botId }, 'Failed to persist sensor cache');
      }
    }

    return allEvents;
  }

  /**
   * Get formatted environment block for prompt injection.
   * Budgeted to MAX_ENVIRONMENT_CHARS.
   */
  async getEnvironmentBlock(botId: string): Promise<string | null> {
    const events = await this.pollAll(botId);
    if (events.length === 0) return null;

    const lines: string[] = ['## Environment'];
    let chars = lines[0].length;

    for (const event of events) {
      const line = `- [${event.category}] ${event.summary}`;
      if (chars + line.length + 1 > MAX_ENVIRONMENT_CHARS) break;
      lines.push(line);
      chars += line.length + 1;
    }

    return lines.length > 1 ? lines.join('\n') : null;
  }

  /**
   * Get cached readings. Falls back to disk if memory cache is empty.
   */
  getCachedEvents(botId: string): StimulusEvent[] {
    const cached = this.cache.get(botId);
    if (cached && cached.length > 0) return cached;

    // Fall back to disk
    if (this.dataDir) {
      try {
        const filePath = join(this.dataDir, botId, 'sensors-latest.json');
        if (existsSync(filePath)) {
          const data = JSON.parse(readFileSync(filePath, 'utf-8'));
          if (Array.isArray(data)) {
            this.cache.set(botId, data);
            return data;
          }
        }
      } catch {
        // ignore
      }
    }

    return [];
  }

  /**
   * Get sensor count for monitoring.
   */
  getSensorCount(): number {
    return this.sensors.length;
  }
}

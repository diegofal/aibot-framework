/**
 * Environmental Sensor types — pluggable stimulus pipeline.
 */

export interface StimulusEvent {
  sensorId: string;
  timestamp: number;
  category: 'time' | 'content' | 'activity' | 'external';
  summary: string;
  relevance: number; // 0.0-1.0
  data?: Record<string, unknown>;
}

export interface Sensor {
  id: string;
  poll(botId: string): Promise<StimulusEvent[]>;
}

export interface SensorConfig {
  time?: { enabled?: boolean };
  rss?: { enabled?: boolean; feeds?: string[] };
  channelActivity?: { enabled?: boolean };
  webhook?: { enabled?: boolean; secret?: string };
}

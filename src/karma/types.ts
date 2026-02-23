export interface KarmaEvent {
  id: string;
  botId: string;
  timestamp: string;
  delta: number;
  reason: string;
  source: 'production' | 'agent-loop' | 'feedback' | 'goal' | 'manual' | 'tool';
  metadata?: Record<string, unknown>;
}

export interface KarmaScore {
  botId: string;
  current: number;
  trend: 'rising' | 'falling' | 'stable';
  recentEvents: KarmaEvent[];
}

export type KarmaTrend = KarmaScore['trend'];

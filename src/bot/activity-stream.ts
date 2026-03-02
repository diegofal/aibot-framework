import { EventEmitter } from 'node:events';

export type ActivityEventType =
  | 'tool:start'
  | 'tool:end'
  | 'tool:error'
  | 'llm:start'
  | 'llm:end'
  | 'llm:error'
  | 'llm:fallback'
  | 'agent:phase'
  | 'agent:idle'
  | 'agent:result'
  | 'memory:flush'
  | 'memory:rag'
  | 'collab:start'
  | 'collab:end'
  | 'compaction'
  | 'karma:change';

export type LlmCaller = 'conversation' | 'planner' | 'strategist' | 'executor' | 'feedback';

export interface LlmCallerStats {
  calls: number;
  totalDurationMs: number;
  errors: number;
}

export interface LlmBotStats {
  botId: string;
  totalCalls: number;
  successCount: number;
  failCount: number;
  fallbackCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  lastCallAt: number | null;
  lastError: string | null;
  callerBreakdown: Record<string, LlmCallerStats>;
}

export interface ActivityEvent {
  type: ActivityEventType;
  botId: string;
  timestamp: number;
  phase?: string;
  data?: Record<string, unknown>;
}

const DEFAULT_BUFFER_SIZE = 200;

export class LlmStatsTracker {
  private stats = new Map<string, LlmBotStats>();

  constructor(stream: ActivityStream) {
    stream.on('activity', (event: ActivityEvent) => {
      if (event.type === 'llm:end') this.onEnd(event);
      else if (event.type === 'llm:error') this.onError(event);
      else if (event.type === 'llm:fallback') this.onFallback(event);
    });
  }

  private ensure(botId: string): LlmBotStats {
    let s = this.stats.get(botId);
    if (!s) {
      s = {
        botId,
        totalCalls: 0,
        successCount: 0,
        failCount: 0,
        fallbackCount: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        lastCallAt: null,
        lastError: null,
        callerBreakdown: {},
      };
      this.stats.set(botId, s);
    }
    return s;
  }

  private ensureCaller(s: LlmBotStats, caller: string): LlmCallerStats {
    if (!s.callerBreakdown[caller]) {
      s.callerBreakdown[caller] = { calls: 0, totalDurationMs: 0, errors: 0 };
    }
    return s.callerBreakdown[caller];
  }

  private onEnd(event: ActivityEvent): void {
    const s = this.ensure(event.botId);
    const durationMs = (event.data?.durationMs as number) ?? 0;
    const caller = (event.data?.caller as string) ?? 'unknown';

    s.totalCalls++;
    s.successCount++;
    s.totalDurationMs += durationMs;
    s.avgDurationMs = Math.round(s.totalDurationMs / s.totalCalls);
    s.lastCallAt = event.timestamp;

    const cs = this.ensureCaller(s, caller);
    cs.calls++;
    cs.totalDurationMs += durationMs;
  }

  private onError(event: ActivityEvent): void {
    const s = this.ensure(event.botId);
    const durationMs = (event.data?.durationMs as number) ?? 0;
    const caller = (event.data?.caller as string) ?? 'unknown';
    const error = (event.data?.error as string) ?? 'unknown error';

    s.totalCalls++;
    s.failCount++;
    s.totalDurationMs += durationMs;
    s.avgDurationMs = Math.round(s.totalDurationMs / s.totalCalls);
    s.lastCallAt = event.timestamp;
    s.lastError = error;

    const cs = this.ensureCaller(s, caller);
    cs.calls++;
    cs.totalDurationMs += durationMs;
    cs.errors++;
  }

  private onFallback(event: ActivityEvent): void {
    const s = this.ensure(event.botId);
    s.fallbackCount++;
  }

  getStats(botId: string): LlmBotStats | undefined {
    return this.stats.get(botId);
  }

  getAllStats(): LlmBotStats[] {
    return [...this.stats.values()];
  }

  clearForBot(botId: string): void {
    this.stats.delete(botId);
  }
}

export class ActivityStream extends EventEmitter {
  private buffer: ActivityEvent[] = [];
  private maxSize: number;
  readonly llmStats: LlmStatsTracker;

  constructor(maxSize: number = DEFAULT_BUFFER_SIZE) {
    super();
    this.maxSize = maxSize;
    this.llmStats = new LlmStatsTracker(this);
  }

  publish(event: ActivityEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
    this.emit('activity', event);
  }

  getRecent(count = 50): ActivityEvent[] {
    return this.buffer.slice(-count);
  }

  clear(): void {
    this.buffer = [];
  }

  /** Remove all events for a specific bot. Returns the number of events removed. */
  clearForBot(botId: string): number {
    const before = this.buffer.length;
    this.buffer = this.buffer.filter((e) => e.botId !== botId);
    this.llmStats.clearForBot(botId);
    return before - this.buffer.length;
  }

  get size(): number {
    return this.buffer.length;
  }
}

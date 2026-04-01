import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

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
  | 'karma:change'
  | 'security:audit';

export type LlmCaller = 'conversation' | 'planner' | 'strategist' | 'executor' | 'feedback';

export interface LlmCallerStats {
  calls: number;
  totalDurationMs: number;
  errors: number;
}

export interface ModelTokenStats {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
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
  totalPromptTokens: number;
  totalCompletionTokens: number;
  modelBreakdown: Record<string, ModelTokenStats>;
}

export interface ActivityEvent {
  type: ActivityEventType;
  botId: string;
  timestamp: number;
  phase?: string;
  data?: Record<string, unknown>;
}

const DEFAULT_BUFFER_SIZE = 2000;

const FLUSH_DEBOUNCE_MS = 5_000;

export class LlmStatsTracker {
  private stats = new Map<string, LlmBotStats>();
  private dataDir: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(stream: ActivityStream, dataDir?: string) {
    if (dataDir) {
      this.dataDir = dataDir;
      this.loadFromDisk();
    }
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
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        modelBreakdown: {},
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

    this.accumulateTokens(s, event);
    this.scheduleDiskFlush();
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

    this.accumulateTokens(s, event);
    this.scheduleDiskFlush();
  }

  private accumulateTokens(s: LlmBotStats, event: ActivityEvent): void {
    const modelName = event.data?.model as string | undefined;
    const tokensIn = event.data?.tokensIn as number | undefined;
    const tokensOut = event.data?.tokensOut as number | undefined;
    if (!modelName || (tokensIn == null && tokensOut == null)) return;

    const promptTokens = tokensIn ?? 0;
    const completionTokens = tokensOut ?? 0;

    s.totalPromptTokens += promptTokens;
    s.totalCompletionTokens += completionTokens;

    let ms = s.modelBreakdown[modelName];
    if (!ms) {
      ms = { model: modelName, promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
      s.modelBreakdown[modelName] = ms;
    }
    ms.promptTokens += promptTokens;
    ms.completionTokens += completionTokens;
    ms.totalTokens += promptTokens + completionTokens;
    ms.calls++;
  }

  private onFallback(event: ActivityEvent): void {
    const s = this.ensure(event.botId);
    s.fallbackCount++;
    this.scheduleDiskFlush();
  }

  getStats(botId: string): LlmBotStats | undefined {
    return this.stats.get(botId);
  }

  getAllStats(): LlmBotStats[] {
    return [...this.stats.values()];
  }

  clearForBot(botId: string): void {
    this.stats.delete(botId);
    if (this.dataDir) {
      const filePath = join(this.dataDir, `${botId}.json`);
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // ignore cleanup errors
      }
    }
    this.scheduleDiskFlush();
  }

  /** Force an immediate write of all stats to disk. */
  flushToDisk(): void {
    if (!this.dataDir) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      for (const [botId, s] of this.stats) {
        writeFileSync(join(this.dataDir, `${botId}.json`), JSON.stringify(s, null, 2), 'utf-8');
      }
      this.dirty = false;
    } catch {
      // best-effort persistence
    }
  }

  private loadFromDisk(): void {
    if (!this.dataDir || !existsSync(this.dataDir)) return;
    try {
      const files = readdirSync(this.dataDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.dataDir as string, file), 'utf-8');
          const data = JSON.parse(raw) as LlmBotStats;
          if (data.botId) {
            this.stats.set(data.botId, data);
          }
        } catch {
          // skip malformed files
        }
      }
    } catch {
      // directory not readable — start fresh
    }
  }

  private scheduleDiskFlush(): void {
    this.dirty = true;
    if (!this.dataDir) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.flushToDisk();
    }, FLUSH_DEBOUNCE_MS);
  }
}

export class ActivityStream extends EventEmitter {
  private buffer: ActivityEvent[] = [];
  private maxSize: number;
  readonly llmStats: LlmStatsTracker;

  constructor(maxSize: number = DEFAULT_BUFFER_SIZE, llmStatsDir?: string) {
    super();
    this.maxSize = maxSize;
    this.llmStats = new LlmStatsTracker(this, llmStatsDir);
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

  /** Return a page of events from the end of the buffer (offset 0 = most recent). */
  getSlice(limit = 50, offset = 0): { events: ActivityEvent[]; total: number } {
    const total = this.buffer.length;
    const end = total - offset;
    const start = Math.max(0, end - limit);
    if (end <= 0) return { events: [], total };
    return { events: this.buffer.slice(start, end), total };
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

import type { Logger } from '../logger';
import type { TenantManager } from './manager';
import type { UsageEventType } from './types';

/**
 * UsageTracker provides fine-grained usage metering for the multi-tenant system.
 * 
 * It tracks:
 * - Message processing
 * - API calls (tool executions, LLM requests)
 * - Storage writes
 * - Collaboration initiations
 * 
 * Usage is recorded in-memory with periodic flush to persistent storage.
 */
export interface UsageTrackerConfig {
  /** Flush interval in milliseconds (default: 5000) */
  flushIntervalMs?: number;
  /** Batch size for flushing (default: 100) */
  batchSize?: number;
  /** Whether to track in real-time or batch mode */
  realtime?: boolean;
}

interface PendingUsage {
  tenantId: string;
  botId: string;
  type: UsageEventType;
  quantity: number;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export class UsageTracker {
  private pending: PendingUsage[] = [];
  private flushTimer?: Timer;
  private config: Required<UsageTrackerConfig>;

  constructor(
    private tenantManager: TenantManager,
    private logger: Logger,
    config: UsageTrackerConfig = {},
  ) {
    this.config = {
      flushIntervalMs: config.flushIntervalMs ?? 5000,
      batchSize: config.batchSize ?? 100,
      realtime: config.realtime ?? false,
    };

    // Start periodic flush if not in realtime mode
    if (!this.config.realtime) {
      this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);
    }
  }

  /**
   * Track a usage event.
   * In realtime mode, flushes immediately. Otherwise, queues for batch flush.
   */
  track(
    tenantId: string,
    botId: string,
    type: UsageEventType,
    quantity: number = 1,
    metadata?: Record<string, unknown>,
  ): void {
    const event: PendingUsage = {
      tenantId,
      botId,
      type,
      quantity,
      metadata,
      timestamp: Date.now(),
    };

    if (this.config.realtime) {
      // Flush immediately in realtime mode
      this.flushSingle(event);
    } else {
      // Queue for batch processing
      this.pending.push(event);
      
      // Flush if batch size reached
      if (this.pending.length >= this.config.batchSize) {
        this.flush();
      }
    }
  }

  /**
   * Track message processing.
   */
  trackMessage(tenantId: string, botId: string, metadata?: { chatId?: number; messageLength?: number }): void {
    this.track(tenantId, botId, 'message_processed', 1, metadata);
  }

  /**
   * Track API/tool call.
   */
  trackApiCall(tenantId: string, botId: string, metadata?: { toolName?: string; durationMs?: number }): void {
    this.track(tenantId, botId, 'api_call', 1, metadata);
  }

  /**
   * Track LLM request.
   */
  trackLLMRequest(
    tenantId: string, 
    botId: string, 
    metadata?: { model?: string; tokensIn?: number; tokensOut?: number }
  ): void {
    // Count tokens as quantity if available
    const quantity = metadata?.tokensIn && metadata?.tokensOut 
      ? metadata.tokensIn + metadata.tokensOut 
      : 1;
    this.track(tenantId, botId, 'llm_request', quantity, metadata);
  }

  /**
   * Track tool execution.
   */
  trackToolExecution(
    tenantId: string, 
    botId: string, 
    toolName: string, 
    metadata?: { durationMs?: number; success?: boolean }
  ): void {
    this.track(tenantId, botId, 'tool_execution', 1, { toolName, ...metadata });
  }

  /**
   * Track collaboration initiation.
   */
  trackCollaboration(
    tenantId: string, 
    botId: string, 
    metadata?: { targetBotId?: string; sessionId?: string }
  ): void {
    this.track(tenantId, botId, 'collaboration_initiated', 1, metadata);
  }

  /**
   * Track storage write.
   */
  trackStorage(tenantId: string, botId: string, bytesWritten: number, metadata?: { path?: string }): void {
    this.track(tenantId, botId, 'storage_write', bytesWritten, metadata);
  }

  /**
   * Track webhook received.
   */
  trackWebhook(tenantId: string, botId: string, metadata?: { webhookType?: string }): void {
    this.track(tenantId, botId, 'webhook_received', 1, metadata);
  }

  /**
   * Flush all pending usage to persistent storage.
   */
  flush(): void {
    if (this.pending.length === 0) return;

    const toFlush = [...this.pending];
    this.pending = [];

    // Aggregate by tenant/bot/type for efficiency
    const aggregated = this.aggregateUsage(toFlush);

    for (const record of aggregated) {
      try {
        this.tenantManager.recordUsage({
          tenantId: record.tenantId,
          botId: record.botId,
          messageCount: record.messages,
          apiCallCount: record.apiCalls,
          storageBytesUsed: record.storage,
        });
      } catch (err) {
        this.logger.error({ err, record }, 'Failed to record usage');
        // Re-queue failed records? For now, log and drop
      }
    }

    this.logger.debug({ count: toFlush.length, aggregated: aggregated.length }, 'Flushed usage');
  }

  /**
   * Flush a single event immediately.
   */
  private flushSingle(event: PendingUsage): void {
    try {
      let messageCount = 0;
      let apiCallCount = 0;
      let storageBytesUsed = 0;

      switch (event.type) {
        case 'message_processed':
          messageCount = event.quantity;
          break;
        case 'api_call':
        case 'llm_request':
        case 'tool_execution':
        case 'collaboration_initiated':
          apiCallCount = event.quantity;
          break;
        case 'storage_write':
          storageBytesUsed = event.quantity;
          break;
        case 'webhook_received':
          // Webhooks don't count
          break;
      }

      this.tenantManager.recordUsage({
        tenantId: event.tenantId,
        botId: event.botId,
        messageCount,
        apiCallCount,
        storageBytesUsed,
      });
    } catch (err) {
      this.logger.error({ err, event }, 'Failed to record single usage');
    }
  }

  /**
   * Aggregate usage events by tenant/bot for efficient storage.
   */
  private aggregateUsage(events: PendingUsage[]): Array<{
    tenantId: string;
    botId: string;
    messages: number;
    apiCalls: number;
    storage: number;
  }> {
    const map = new Map<string, { messages: number; apiCalls: number; storage: number }>();

    for (const event of events) {
      const key = `${event.tenantId}:${event.botId}`;
      const existing = map.get(key) ?? { messages: 0, apiCalls: 0, storage: 0 };

      switch (event.type) {
        case 'message_processed':
          existing.messages += event.quantity;
          break;
        case 'api_call':
        case 'llm_request':
        case 'tool_execution':
        case 'collaboration_initiated':
          existing.apiCalls += event.quantity;
          break;
        case 'storage_write':
          existing.storage += event.quantity;
          break;
        case 'webhook_received':
          // Webhooks don't count
          break;
      }

      map.set(key, existing);
    }

    return Array.from(map.entries()).map(([key, counts]) => {
      const [tenantId, botId] = key.split(':');
      return { tenantId, botId, ...counts };
    });
  }

  /**
   * Get current pending count (for monitoring).
   */
  getPendingCount(): number {
    return this.pending.length;
  }

  /**
   * Dispose and cleanup.
   */
  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    // Final flush
    this.flush();
  }
}

/**
 * Create a usage tracker with sensible defaults for production.
 */
export function createUsageTracker(
  tenantManager: TenantManager,
  logger: Logger,
  realtime: boolean = false,
): UsageTracker {
  return new UsageTracker(tenantManager, logger, {
    flushIntervalMs: realtime ? 1000 : 10000,
    batchSize: realtime ? 10 : 100,
    realtime,
  });
}

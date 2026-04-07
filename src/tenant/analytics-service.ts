/**
 * Analytics service — conversation metrics, resolution rates, usage trends.
 *
 * Collects events from the conversation pipeline and aggregates them into
 * tenant-scoped metrics. Data is stored as append-only JSONL files per tenant
 * for fast time-range queries.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// --- Event types ---

export type AnalyticsEventType =
  | 'conversation.started'
  | 'conversation.message'
  | 'conversation.ended'
  | 'conversation.resolved'
  | 'tool.called'
  | 'error.occurred'
  | 'topic_guard.blocked';

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  tenantId: string;
  botId: string;
  chatId: string;
  userId?: string;
  channelKind: string;
  timestamp: string;
  /** Event-specific payload */
  data?: Record<string, unknown>;
}

// --- Aggregated metrics ---

export interface ConversationMetrics {
  /** Total conversations started in the period */
  totalConversations: number;
  /** Total messages exchanged (inbound + outbound) */
  totalMessages: number;
  /** Unique users who sent at least one message */
  uniqueUsers: number;
  /** Messages broken down by channel */
  messagesByChannel: Record<string, number>;
  /** Average messages per conversation */
  avgMessagesPerConversation: number;
  /** Conversations explicitly resolved (e.g., user said thanks / goal met) */
  resolvedConversations: number;
  /** Resolution rate (resolved / total, 0-1) */
  resolutionRate: number;
  /** Tool calls broken down by tool name */
  toolUsage: Record<string, number>;
  /** Errors by type */
  errorsByType: Record<string, number>;
  /** Conversations per day (YYYY-MM-DD → count) */
  conversationsPerDay: Record<string, number>;
  /** Messages per day */
  messagesPerDay: Record<string, number>;
  /** Active bots in the period */
  activeBots: string[];
}

export interface BotMetrics {
  botId: string;
  totalConversations: number;
  totalMessages: number;
  uniqueUsers: number;
  resolvedConversations: number;
  resolutionRate: number;
  avgMessagesPerConversation: number;
  messagesByChannel: Record<string, number>;
  toolUsage: Record<string, number>;
}

export class AnalyticsService {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = join(dataDir, 'analytics');
    mkdirSync(this.dataDir, { recursive: true });
  }

  /**
   * Record a single analytics event. Append-only, tenant-scoped file.
   */
  record(event: Omit<AnalyticsEvent, 'timestamp'>): void {
    const full: AnalyticsEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    const filePath = this.tenantFile(event.tenantId);
    writeFileSync(filePath, `${JSON.stringify(full)}\n`, { flag: 'a' });
  }

  /**
   * Get aggregated metrics for a tenant in a time range.
   */
  getMetrics(tenantId: string, startDate: string, endDate: string): ConversationMetrics {
    const events = this.readEvents(tenantId, startDate, endDate);
    return this.aggregate(events);
  }

  /**
   * Get per-bot metrics for a tenant in a time range.
   */
  getBotMetrics(tenantId: string, botId: string, startDate: string, endDate: string): BotMetrics {
    const events = this.readEvents(tenantId, startDate, endDate).filter((e) => e.botId === botId);
    const agg = this.aggregate(events);
    return {
      botId,
      totalConversations: agg.totalConversations,
      totalMessages: agg.totalMessages,
      uniqueUsers: agg.uniqueUsers,
      resolvedConversations: agg.resolvedConversations,
      resolutionRate: agg.resolutionRate,
      avgMessagesPerConversation: agg.avgMessagesPerConversation,
      messagesByChannel: agg.messagesByChannel,
      toolUsage: agg.toolUsage,
    };
  }

  /**
   * Get a summary of metrics for the current month.
   */
  getCurrentMonthMetrics(tenantId: string): ConversationMetrics {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endOfMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
      23,
      59,
      59,
      999
    ).toISOString();
    return this.getMetrics(tenantId, startOfMonth, endOfMonth);
  }

  // --- Internals ---

  private tenantFile(tenantId: string): string {
    return join(this.dataDir, `${tenantId}.jsonl`);
  }

  private readEvents(tenantId: string, startDate: string, endDate: string): AnalyticsEvent[] {
    const filePath = this.tenantFile(tenantId);
    if (!existsSync(filePath)) return [];

    const events: AnalyticsEvent[] = [];
    const content = readFileSync(filePath, 'utf-8');

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event: AnalyticsEvent = JSON.parse(line);
        if (event.timestamp >= startDate && event.timestamp <= endDate) {
          events.push(event);
        }
      } catch {
        // Skip corrupt lines
      }
    }

    return events;
  }

  private aggregate(events: AnalyticsEvent[]): ConversationMetrics {
    const conversations = new Set<string>();
    const users = new Set<string>();
    const bots = new Set<string>();
    const messagesByChannel: Record<string, number> = {};
    const toolUsage: Record<string, number> = {};
    const errorsByType: Record<string, number> = {};
    const conversationsPerDay: Record<string, number> = {};
    const messagesPerDay: Record<string, number> = {};
    let totalMessages = 0;
    let resolvedConversations = 0;

    for (const event of events) {
      const day = event.timestamp.slice(0, 10); // YYYY-MM-DD
      const convKey = `${event.botId}:${event.chatId}`;

      switch (event.type) {
        case 'conversation.started':
          conversations.add(convKey);
          conversationsPerDay[day] = (conversationsPerDay[day] ?? 0) + 1;
          bots.add(event.botId);
          break;

        case 'conversation.message':
          totalMessages++;
          messagesByChannel[event.channelKind] = (messagesByChannel[event.channelKind] ?? 0) + 1;
          messagesPerDay[day] = (messagesPerDay[day] ?? 0) + 1;
          if (event.userId) users.add(event.userId);
          conversations.add(convKey);
          bots.add(event.botId);
          break;

        case 'conversation.resolved':
          resolvedConversations++;
          break;

        case 'tool.called': {
          const toolName = (event.data?.toolName as string) ?? 'unknown';
          toolUsage[toolName] = (toolUsage[toolName] ?? 0) + 1;
          break;
        }

        case 'error.occurred': {
          const errorType = (event.data?.errorType as string) ?? 'unknown';
          errorsByType[errorType] = (errorsByType[errorType] ?? 0) + 1;
          break;
        }
      }
    }

    const totalConversations = conversations.size;
    return {
      totalConversations,
      totalMessages,
      uniqueUsers: users.size,
      messagesByChannel,
      avgMessagesPerConversation: totalConversations > 0 ? totalMessages / totalConversations : 0,
      resolvedConversations,
      resolutionRate: totalConversations > 0 ? resolvedConversations / totalConversations : 0,
      toolUsage,
      errorsByType,
      conversationsPerDay,
      messagesPerDay,
      activeBots: Array.from(bots),
    };
  }
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsService } from '../../src/tenant/analytics-service';

describe('AnalyticsService', () => {
  let tmpDir: string;
  let service: AnalyticsService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'analytics-test-'));
    service = new AnalyticsService(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records and retrieves events', () => {
    service.record({
      type: 'conversation.message',
      tenantId: 't1',
      botId: 'b1',
      chatId: 'c1',
      userId: 'u1',
      channelKind: 'rest',
    });

    const metrics = service.getMetrics(t1(), '2000-01-01', '2099-12-31');
    expect(metrics.totalMessages).toBe(1);
    expect(metrics.uniqueUsers).toBe(1);
    expect(metrics.messagesByChannel.rest).toBe(1);
  });

  it('aggregates conversation metrics correctly', () => {
    // Conversation 1: 3 messages
    for (let i = 0; i < 3; i++) {
      service.record({
        type: 'conversation.message',
        tenantId: 't1',
        botId: 'b1',
        chatId: 'c1',
        userId: 'u1',
        channelKind: 'web',
      });
    }

    // Conversation 2: 2 messages, resolved
    for (let i = 0; i < 2; i++) {
      service.record({
        type: 'conversation.message',
        tenantId: 't1',
        botId: 'b1',
        chatId: 'c2',
        userId: 'u2',
        channelKind: 'telegram',
      });
    }
    service.record({
      type: 'conversation.resolved',
      tenantId: 't1',
      botId: 'b1',
      chatId: 'c2',
      channelKind: 'telegram',
    });

    const metrics = service.getMetrics(t1(), '2000-01-01', '2099-12-31');
    expect(metrics.totalMessages).toBe(5);
    expect(metrics.totalConversations).toBe(2); // c1 + c2
    expect(metrics.uniqueUsers).toBe(2);
    expect(metrics.avgMessagesPerConversation).toBe(2.5);
    expect(metrics.resolvedConversations).toBe(1);
    expect(metrics.resolutionRate).toBe(0.5);
    expect(metrics.messagesByChannel.web).toBe(3);
    expect(metrics.messagesByChannel.telegram).toBe(2);
    expect(metrics.activeBots).toEqual(['b1']);
  });

  it('tracks tool usage', () => {
    service.record({
      type: 'tool.called',
      tenantId: 't1',
      botId: 'b1',
      chatId: 'c1',
      channelKind: 'rest',
      data: { toolName: 'save_memory' },
    });
    service.record({
      type: 'tool.called',
      tenantId: 't1',
      botId: 'b1',
      chatId: 'c1',
      channelKind: 'rest',
      data: { toolName: 'save_memory' },
    });
    service.record({
      type: 'tool.called',
      tenantId: 't1',
      botId: 'b1',
      chatId: 'c1',
      channelKind: 'rest',
      data: { toolName: 'web_search' },
    });

    const metrics = service.getMetrics(t1(), '2000-01-01', '2099-12-31');
    expect(metrics.toolUsage.save_memory).toBe(2);
    expect(metrics.toolUsage.web_search).toBe(1);
  });

  it('tracks errors by type', () => {
    service.record({
      type: 'error.occurred',
      tenantId: 't1',
      botId: 'b1',
      chatId: 'c1',
      channelKind: 'rest',
      data: { errorType: 'llm_timeout' },
    });

    const metrics = service.getMetrics(t1(), '2000-01-01', '2099-12-31');
    expect(metrics.errorsByType.llm_timeout).toBe(1);
  });

  it('filters by date range', () => {
    // Record event — timestamp is auto-set to now
    service.record({
      type: 'conversation.message',
      tenantId: 't1',
      botId: 'b1',
      chatId: 'c1',
      channelKind: 'rest',
    });

    // Query for a past range that excludes today
    const metrics = service.getMetrics(t1(), '2020-01-01', '2020-12-31');
    expect(metrics.totalMessages).toBe(0);
  });

  it('returns per-bot metrics', () => {
    service.record({
      type: 'conversation.message',
      tenantId: 't1',
      botId: 'b1',
      chatId: 'c1',
      userId: 'u1',
      channelKind: 'rest',
    });
    service.record({
      type: 'conversation.message',
      tenantId: 't1',
      botId: 'b2',
      chatId: 'c2',
      userId: 'u2',
      channelKind: 'web',
    });

    const b1Metrics = service.getBotMetrics(t1(), 'b1', '2000-01-01', '2099-12-31');
    expect(b1Metrics.botId).toBe('b1');
    expect(b1Metrics.totalMessages).toBe(1);
    expect(b1Metrics.uniqueUsers).toBe(1);

    const b2Metrics = service.getBotMetrics(t1(), 'b2', '2000-01-01', '2099-12-31');
    expect(b2Metrics.totalMessages).toBe(1);
  });

  it('isolates tenants', () => {
    service.record({
      type: 'conversation.message',
      tenantId: 't1',
      botId: 'b1',
      chatId: 'c1',
      channelKind: 'rest',
    });
    service.record({
      type: 'conversation.message',
      tenantId: 't2',
      botId: 'b2',
      chatId: 'c2',
      channelKind: 'rest',
    });

    const t1Metrics = service.getMetrics(t1(), '2000-01-01', '2099-12-31');
    expect(t1Metrics.totalMessages).toBe(1);

    const t2Metrics = service.getMetrics('t2', '2000-01-01', '2099-12-31');
    expect(t2Metrics.totalMessages).toBe(1);
  });

  it('getCurrentMonthMetrics returns events from current month', () => {
    service.record({
      type: 'conversation.message',
      tenantId: 't1',
      botId: 'b1',
      chatId: 'c1',
      channelKind: 'rest',
    });

    const metrics = service.getCurrentMonthMetrics(t1());
    expect(metrics.totalMessages).toBe(1);
  });

  it('returns empty metrics for tenant with no data', () => {
    const metrics = service.getMetrics('nonexistent', '2000-01-01', '2099-12-31');
    expect(metrics.totalConversations).toBe(0);
    expect(metrics.totalMessages).toBe(0);
    expect(metrics.uniqueUsers).toBe(0);
    expect(metrics.resolutionRate).toBe(0);
  });
});

function t1() {
  return 't1';
}

import { describe, expect, test } from 'bun:test';
import {
  type UserAwarenessConfig,
  buildActiveUsersSummary,
} from '../../src/bot/agent-loop-user-context';

// Mock SessionManager
function createMockSessionManager(sessions: Array<{ key: string; meta: any }>) {
  return {
    listSessions: () => sessions.map((s) => ({ key: s.key, ...s.meta })),
    getSessionMeta: (key: string) => sessions.find((s) => s.key === key)?.meta ?? undefined,
  } as any;
}

const defaultConfig: UserAwarenessConfig = {
  enabled: true,
  activeWindowHours: 24,
  maxUsers: 5,
};

describe('buildActiveUsersSummary', () => {
  test('returns null when disabled', () => {
    const sm = createMockSessionManager([]);
    const result = buildActiveUsersSummary(sm, 'bot1', { ...defaultConfig, enabled: false });
    expect(result).toBeNull();
  });

  test('returns null when no sessions', () => {
    const sm = createMockSessionManager([]);
    const result = buildActiveUsersSummary(sm, 'bot1', defaultConfig);
    expect(result).toBeNull();
  });

  test('returns null when no sessions for this bot', () => {
    const sm = createMockSessionManager([
      {
        key: 'bot:other-bot:private:123',
        meta: { lastActivityAt: new Date().toISOString(), messageCount: 5 },
      },
    ]);
    const result = buildActiveUsersSummary(sm, 'bot1', defaultConfig);
    expect(result).toBeNull();
  });

  test('returns summary for active users', () => {
    const sm = createMockSessionManager([
      {
        key: 'bot:bot1:private:user-a',
        meta: {
          key: 'bot:bot1:private:user-a',
          lastActivityAt: new Date(Date.now() - 60000).toISOString(),
          messageCount: 10,
        },
      },
      {
        key: 'bot:bot1:private:user-b',
        meta: {
          key: 'bot:bot1:private:user-b',
          lastActivityAt: new Date(Date.now() - 3600000).toISOString(),
          messageCount: 5,
        },
      },
    ]);
    const result = buildActiveUsersSummary(sm, 'bot1', defaultConfig);
    expect(result).not.toBeNull();
    expect(result).toContain('user-a');
    expect(result).toContain('user-b');
    expect(result).toContain('Active Users');
  });

  test('respects maxUsers limit', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      key: `bot:bot1:private:user-${i}`,
      meta: {
        key: `bot:bot1:private:user-${i}`,
        lastActivityAt: new Date(Date.now() - i * 60000).toISOString(),
        messageCount: i + 1,
      },
    }));
    const sm = createMockSessionManager(sessions);
    const result = buildActiveUsersSummary(sm, 'bot1', { ...defaultConfig, maxUsers: 3 });
    expect(result).not.toBeNull();
    expect(result).toContain('user-0');
    expect(result).toContain('...and 7 more');
  });

  test('filters out sessions outside time window', () => {
    const sm = createMockSessionManager([
      {
        key: 'bot:bot1:private:active',
        meta: {
          key: 'bot:bot1:private:active',
          lastActivityAt: new Date(Date.now() - 3600000).toISOString(),
          messageCount: 5,
        },
      },
      {
        key: 'bot:bot1:private:old',
        meta: {
          key: 'bot:bot1:private:old',
          lastActivityAt: new Date(Date.now() - 48 * 3600000).toISOString(),
          messageCount: 3,
        },
      },
    ]);
    const result = buildActiveUsersSummary(sm, 'bot1', defaultConfig);
    expect(result).not.toBeNull();
    expect(result).toContain('active');
    expect(result).not.toContain('| old |');
  });

  test('filters out userId 0 and undefined', () => {
    const sm = createMockSessionManager([
      {
        key: 'bot:bot1:private:0',
        meta: {
          key: 'bot:bot1:private:0',
          lastActivityAt: new Date().toISOString(),
          messageCount: 5,
        },
      },
      {
        key: 'bot:bot1:private:undefined',
        meta: {
          key: 'bot:bot1:private:undefined',
          lastActivityAt: new Date().toISOString(),
          messageCount: 3,
        },
      },
    ]);
    const result = buildActiveUsersSummary(sm, 'bot1', defaultConfig);
    expect(result).toBeNull();
  });

  test('sorts users by lastActive descending', () => {
    const sm = createMockSessionManager([
      {
        key: 'bot:bot1:private:older',
        meta: {
          key: 'bot:bot1:private:older',
          lastActivityAt: new Date(Date.now() - 7200000).toISOString(),
          messageCount: 2,
        },
      },
      {
        key: 'bot:bot1:private:newer',
        meta: {
          key: 'bot:bot1:private:newer',
          lastActivityAt: new Date(Date.now() - 60000).toISOString(),
          messageCount: 8,
        },
      },
    ]);
    const result = buildActiveUsersSummary(sm, 'bot1', defaultConfig);
    expect(result).not.toBeNull();
    // 'newer' should appear before 'older' in the table
    const newerIdx = result?.indexOf('newer');
    const olderIdx = result?.indexOf('older');
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  test('includes send_proactive_message hint', () => {
    const sm = createMockSessionManager([
      {
        key: 'bot:bot1:private:user1',
        meta: {
          key: 'bot:bot1:private:user1',
          lastActivityAt: new Date().toISOString(),
          messageCount: 1,
        },
      },
    ]);
    const result = buildActiveUsersSummary(sm, 'bot1', defaultConfig);
    expect(result).toContain('send_proactive_message');
  });
});

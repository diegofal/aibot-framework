import { describe, expect, test, vi } from 'bun:test';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { agentLoopRoutes } from '../../../src/web/routes/agent-loop';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

function makeConfig(): Config {
  return {
    agentLoop: {
      enabled: true,
      every: '5m',
      minInterval: '1m',
      maxInterval: '24h',
    },
  } as any;
}

function makeBotManager(overrides: Record<string, any> = {}): any {
  return {
    getAgentLoopState: vi.fn().mockReturnValue({
      running: false,
      sleeping: false,
      draining: false,
      lastRunAt: null,
      lastResults: [],
      nextRunAt: null,
      botSchedules: [],
    }),
    runAgentLoopAll: vi.fn().mockResolvedValue([]),
    runAgentLoop: vi.fn().mockResolvedValue({ botId: 'bot1', status: 'completed' }),
    isRunning: vi.fn().mockReturnValue(true),
    gracefulStopAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('agent-loop routes', () => {
  test('GET / returns state with draining field', async () => {
    const botManager = makeBotManager();
    botManager.getAgentLoopState.mockReturnValue({
      running: true,
      sleeping: false,
      draining: true,
      lastRunAt: 1000,
      lastResults: [],
      nextRunAt: 2000,
      botSchedules: [],
    });

    const app = new Hono();
    app.route(
      '/api/agent-loop',
      agentLoopRoutes({ config: makeConfig(), botManager, logger: noopLogger })
    );

    const res = await app.request('/api/agent-loop');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draining).toBe(true);
    expect(body.running).toBe(true);
  });

  test('POST /stop-safe calls gracefulStopAll and returns ok', async () => {
    const botManager = makeBotManager();
    const app = new Hono();
    app.route(
      '/api/agent-loop',
      agentLoopRoutes({ config: makeConfig(), botManager, logger: noopLogger })
    );

    const res = await app.request('/api/agent-loop/stop-safe', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(botManager.gracefulStopAll).toHaveBeenCalledTimes(1);
  });

  test('POST /stop-safe returns 500 on error', async () => {
    const botManager = makeBotManager({
      gracefulStopAll: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const app = new Hono();
    app.route(
      '/api/agent-loop',
      agentLoopRoutes({ config: makeConfig(), botManager, logger: noopLogger })
    );

    const res = await app.request('/api/agent-loop/stop-safe', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('boom');
  });

  test('POST /run triggers runAgentLoopAll', async () => {
    const botManager = makeBotManager();
    const app = new Hono();
    app.route(
      '/api/agent-loop',
      agentLoopRoutes({ config: makeConfig(), botManager, logger: noopLogger })
    );

    const res = await app.request('/api/agent-loop/run', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(botManager.runAgentLoopAll).toHaveBeenCalledTimes(1);
  });
});

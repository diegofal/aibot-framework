/**
 * The dashboard must be able to tell a revoked token from a deliberately
 * headless bot. Both `GET /api/agents` (per bot) and `GET /api/status` carry
 * the same `channel` object so the two views cannot disagree.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { ChannelStatus } from '../../../src/bot/telegram-errors';
import type { BotConfig, Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { agentsRoutes } from '../../../src/web/routes/agents';
import { statusRoutes } from '../../../src/web/routes/status';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const DEFAULT_CHANNEL: ChannelStatus = {
  kind: 'telegram',
  state: 'ok',
  lastError: null,
  checkedAt: '2026-08-21T10:00:00Z',
};
const CRYPTIK_CHANNEL: ChannelStatus = {
  kind: 'headless',
  state: 'revoked',
  lastError: 'Telegram rejected the bot token (401 Unauthorized)',
  checkedAt: '2026-08-21T10:00:01Z',
};
const CHANNELS: Record<string, ChannelStatus | undefined> = {
  default: DEFAULT_CHANNEL,
  cryptik: CRYPTIK_CHANNEL,
  selfimprove: { kind: 'headless', state: 'placeholder', lastError: null, checkedAt: null },
  never: undefined,
};

function makeConfig(): Config {
  const bots = [
    { id: 'default', name: 'Default', token: 'x', enabled: true, skills: [] },
    { id: 'cryptik', name: 'Cryptik', token: 'y', enabled: true, skills: [] },
    { id: 'selfimprove', name: 'Self', token: 'nothing', enabled: true, skills: [] },
    { id: 'never', name: 'Never', token: 'z', enabled: false, skills: [] },
  ] as BotConfig[];
  return {
    bots,
    ollama: { models: { primary: 'llama3' } },
    conversation: {},
    soul: { dir: './soul' },
    productions: { baseDir: './productions' },
    agentLoop: { enabled: false, every: '6h' },
  } as unknown as Config;
}

function makeBotManager() {
  const running = new Set(['default', 'cryptik', 'selfimprove']);
  return {
    isRunning: (id: string) => running.has(id),
    getBotIds: () => [...running],
    getChannelState: (id: string) => CHANNELS[id],
    getAvailableToolNames: () => [],
    getExternalSkillNames: () => [],
  } as any;
}

describe('GET /api/agents exposes channel', () => {
  const app = new Hono();
  app.route(
    '/api/agents',
    agentsRoutes({
      config: makeConfig(),
      botManager: makeBotManager(),
      skillRegistry: {} as any,
      configPath: 'unused.json',
      logger: noopLogger,
    })
  );

  test('each bot object carries channel {kind,state,lastError,checkedAt}', async () => {
    const res = await app.request('/api/agents');
    expect(res.status).toBe(200);
    const agents = (await res.json()) as Array<{ id: string; channel: ChannelStatus | null }>;
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

    expect(byId.default.channel).toEqual(DEFAULT_CHANNEL);
    expect(byId.cryptik.channel?.state).toBe('revoked');
    expect(byId.cryptik.channel?.lastError).toMatch(/401/);
    expect(byId.selfimprove.channel).toEqual(CHANNELS.selfimprove);
    // Unknown (never started, shaped token) is an explicit null, not a missing key.
    expect('channel' in byId.never).toBe(true);
    expect(byId.never.channel).toBeNull();
  });

  test('single agent endpoint carries the same channel object', async () => {
    const res = await app.request('/api/agents/cryptik');
    expect(res.status).toBe(200);
    const agent = (await res.json()) as { channel: ChannelStatus };
    expect(agent.channel).toEqual(CRYPTIK_CHANNEL);
  });
});

describe('GET /api/status exposes channel per bot', () => {
  const app = new Hono();
  app.route('/api/status', statusRoutes({ config: makeConfig(), botManager: makeBotManager() }));

  test('bots.channels lists every configured bot with running flag and channel', async () => {
    const res = await app.request('/api/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bots: {
        configured: number;
        running: number;
        ids: string[];
        channels: Array<{ id: string; running: boolean; channel: ChannelStatus | null }>;
      };
    };

    expect(body.bots.configured).toBe(4);
    expect(body.bots.running).toBe(3);
    const byId = Object.fromEntries(body.bots.channels.map((c) => [c.id, c]));
    expect(byId.default).toEqual({ id: 'default', running: true, channel: DEFAULT_CHANNEL });
    expect(byId.cryptik.channel?.state).toBe('revoked');
    expect(byId.selfimprove.channel?.state).toBe('placeholder');
    expect(byId.never).toEqual({ id: 'never', running: false, channel: null });
  });
});

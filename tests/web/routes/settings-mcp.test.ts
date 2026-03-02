import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotManager } from '../../../src/bot';
import type { Logger } from '../../../src/logger';
import { settingsRoutes } from '../../../src/web/routes/settings';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(process.cwd(), '.test-settings-mcp');
const CONFIG_PATH = join(TEST_DIR, 'config.json');

function createBaseConfig() {
  return {
    bots: [],
    mcp: {
      servers: [],
      expose: { enabled: false },
    },
    session: {
      groupActivation: 'mention',
      replyWindow: 0,
      forumTopicIsolation: false,
      resetPolicy: { daily: { enabled: false, hour: 0 }, idle: { enabled: false, minutes: 30 } },
      llmRelevanceCheck: {
        enabled: false,
        temperature: 0.1,
        timeout: 5000,
        contextMessages: 3,
        broadcastCheck: false,
      },
    },
    collaboration: {
      enabled: true,
      maxRounds: 5,
      cooldownMs: 10000,
      internalQueryTimeout: 30000,
      enableTargetTools: false,
      maxConverseTurns: 5,
      sessionTtlMs: 300000,
      visibleMaxTurns: 3,
    },
    skillsFolders: { paths: [] },
    productions: { baseDir: './productions' },
    paths: { skills: './src/skills' },
  };
}

function createMockBotManager(overrides?: Record<string, unknown>) {
  const registerMcpToolsCalls: unknown[] = [];
  const pool = {
    addServer: () => ({
      connect: async () => {},
    }),
    removeServer: async () => {},
    getStatus: () => [],
    connectedCount: 0,
    size: 0,
    ...overrides,
  };
  const toolRegistry = {
    registerMcpTools: () => {
      registerMcpToolsCalls.push(true);
    },
  };
  const bm = {
    getMcpClientPool: () => pool,
    getToolRegistry: () => toolRegistry,
    _registerMcpToolsCalls: registerMcpToolsCalls,
  } as unknown as BotManager & { _registerMcpToolsCalls: unknown[] };
  return bm;
}

function setupApp(config: ReturnType<typeof createBaseConfig>, botManager?: BotManager) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  const app = new Hono();
  app.route(
    '/api/settings',
    settingsRoutes({
      config: config as any,
      configPath: CONFIG_PATH,
      logger: noopLogger,
      botManager,
    })
  );
  return app;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('GET /api/settings/mcp', () => {
  test('returns config and status', async () => {
    const config = createBaseConfig();
    config.mcp.servers.push({
      name: 'test-server',
      transport: 'stdio',
      command: 'echo',
      timeout: 30000,
      autoReconnect: true,
    } as any);

    const mockBm = createMockBotManager({
      getStatus: () => [
        {
          name: 'test-server',
          status: 'connected',
          toolCount: 3,
          serverInfo: null,
          prefix: 'test_server',
        },
      ],
      connectedCount: 1,
      size: 1,
    });

    const app = setupApp(config, mockBm);
    const res = await app.request('/api/settings/mcp');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].name).toBe('test-server');
    expect(data.totalCount).toBe(1);
  });

  test('returns empty when no MCP configured', async () => {
    const config = createBaseConfig();
    const app = setupApp(config, createMockBotManager());
    const res = await app.request('/api/settings/mcp');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.servers).toHaveLength(0);
    expect(data.totalCount).toBe(0);
  });
});

describe('POST /api/settings/mcp/servers', () => {
  test('adds server and persists', async () => {
    const config = createBaseConfig();
    const app = setupApp(config, createMockBotManager());

    const res = await app.request('/api/settings/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'new-server',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'some-server'],
        timeout: 15000,
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.server.name).toBe('new-server');

    // Verify persistence
    const persisted = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    expect(persisted.mcp.servers).toHaveLength(1);
    expect(persisted.mcp.servers[0].name).toBe('new-server');
  });

  test('rejects duplicate name', async () => {
    const config = createBaseConfig();
    config.mcp.servers.push({
      name: 'existing',
      transport: 'stdio',
      command: 'echo',
      timeout: 30000,
      autoReconnect: true,
    } as any);

    const app = setupApp(config, createMockBotManager());

    const res = await app.request('/api/settings/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'existing',
        transport: 'stdio',
        command: 'echo',
      }),
    });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('already exists');
  });

  test('rejects missing name', async () => {
    const config = createBaseConfig();
    const app = setupApp(config, createMockBotManager());

    const res = await app.request('/api/settings/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transport: 'stdio', command: 'echo' }),
    });

    expect(res.status).toBe(400);
  });

  test('rejects invalid transport', async () => {
    const config = createBaseConfig();
    const app = setupApp(config, createMockBotManager());

    const res = await app.request('/api/settings/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', transport: 'websocket', command: 'echo' }),
    });

    expect(res.status).toBe(400);
  });

  test('rejects stdio without command', async () => {
    const config = createBaseConfig();
    const app = setupApp(config, createMockBotManager());

    const res = await app.request('/api/settings/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', transport: 'stdio' }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('command is required');
  });

  test('rejects sse without url', async () => {
    const config = createBaseConfig();
    const app = setupApp(config, createMockBotManager());

    const res = await app.request('/api/settings/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', transport: 'sse' }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('url is required');
  });

  test('calls registerMcpTools after successful connect', async () => {
    const config = createBaseConfig();
    const mockBm = createMockBotManager();
    const app = setupApp(config, mockBm);

    const res = await app.request('/api/settings/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'sync-test',
        transport: 'stdio',
        command: 'echo',
      }),
    });

    expect(res.status).toBe(201);
    expect(mockBm._registerMcpToolsCalls).toHaveLength(1);
  });
});

describe('DELETE /api/settings/mcp/servers/:name', () => {
  test('removes and persists', async () => {
    const config = createBaseConfig();
    config.mcp.servers.push({
      name: 'to-remove',
      transport: 'stdio',
      command: 'echo',
      timeout: 30000,
      autoReconnect: true,
    } as any);

    const removedServers: string[] = [];
    const mockBm = createMockBotManager({
      removeServer: async (name: string) => {
        removedServers.push(name);
      },
    });

    const app = setupApp(config, mockBm);

    const res = await app.request('/api/settings/mcp/servers/to-remove', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify persistence
    const persisted = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    expect(persisted.mcp.servers).toHaveLength(0);

    // Verify pool disconnect was called
    expect(removedServers).toContain('to-remove');
  });

  test('returns 404 for unknown server', async () => {
    const config = createBaseConfig();
    const app = setupApp(config, createMockBotManager());

    const res = await app.request('/api/settings/mcp/servers/nonexistent', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
  });

  test('calls registerMcpTools after removal', async () => {
    const config = createBaseConfig();
    config.mcp.servers.push({
      name: 'sync-remove',
      transport: 'stdio',
      command: 'echo',
      timeout: 30000,
      autoReconnect: true,
    } as any);

    const mockBm = createMockBotManager();
    const app = setupApp(config, mockBm);

    const res = await app.request('/api/settings/mcp/servers/sync-remove', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(mockBm._registerMcpToolsCalls).toHaveLength(1);
  });
});

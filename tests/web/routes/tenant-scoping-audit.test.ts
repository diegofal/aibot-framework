/**
 * Tests for multi-tenant endpoint scoping audit.
 * Verifies that non-admin tenants cannot see/modify data from other tenants' bots.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { AgentProposalStore } from '../../../src/tools/agent-proposal-store';
import { agentLoopRoutes } from '../../../src/web/routes/agent-loop';
import { agentProposalRoutes } from '../../../src/web/routes/agent-proposals';
import { dashboardRoutes } from '../../../src/web/routes/dashboard';
import { integrationsRoutes } from '../../../src/web/routes/integrations';
import { mcpRoutes } from '../../../src/web/routes/mcp';
import { settingsRoutes } from '../../../src/web/routes/settings';
import { statusRoutes } from '../../../src/web/routes/status';
import { toolsRoutes } from '../../../src/web/routes/tools';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

/** Middleware that simulates a tenant context */
function tenantMiddleware(tenantId: string) {
  return async (c: Context, next: Next) => {
    c.set('tenant', { tenantId, apiKey: 'test-key', plan: 'pro' });
    return next();
  };
}

/** Middleware that simulates admin context */
function adminMiddleware() {
  return tenantMiddleware('__admin__');
}

/** Config with bots belonging to different tenants */
function makeMultiTenantConfig(): Config {
  return {
    bots: [
      {
        id: 'bot-a1',
        name: 'Bot A1',
        tenantId: 'tenant-A',
        skills: [],
        token: '',
        enabled: true,
        disabledSkills: [],
        plan: 'free',
      },
      {
        id: 'bot-a2',
        name: 'Bot A2',
        tenantId: 'tenant-A',
        skills: [],
        token: '',
        enabled: true,
        disabledSkills: [],
        plan: 'free',
      },
      {
        id: 'bot-b1',
        name: 'Bot B1',
        tenantId: 'tenant-B',
        skills: [],
        token: '',
        enabled: true,
        disabledSkills: [],
        plan: 'free',
      },
    ],
    agentLoop: { enabled: true, every: '5m', minInterval: '1m', maxInterval: '24h' },
    soul: { dir: '/tmp/soul', search: { mmr: {}, autoRag: {} }, healthCheck: {} },
    ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'llama3' }, timeout: 30000 },
    session: {
      groupActivation: 'auto',
      replyWindow: 30,
      forumTopicIsolation: false,
      resetPolicy: { daily: {}, idle: {} },
      llmRelevanceCheck: {},
    },
    collaboration: {},
    skillsFolders: { paths: [] },
    paths: { skills: './skills' },
    mcp: { servers: [] },
    claudeCli: {},
    productions: { baseDir: './productions' },
    conversation: { systemPrompt: '', temperature: 0.7, maxHistory: 20 },
  } as unknown as Config;
}

// ─── Group 1: Data leak fixes ───────────────────────────────────────────

describe('1.1 agent-loop GET / — tenant scoping of botSchedules/lastResults', () => {
  function makeBotManager() {
    return {
      getAgentLoopState: vi.fn().mockReturnValue({
        running: true,
        sleeping: false,
        draining: false,
        lastRunAt: 1000,
        lastResults: [
          { botId: 'bot-a1', botName: 'Bot A1', status: 'completed', summary: '', durationMs: 100 },
          { botId: 'bot-b1', botName: 'Bot B1', status: 'completed', summary: '', durationMs: 200 },
        ],
        nextRunAt: 2000,
        botSchedules: [
          {
            botId: 'bot-a1',
            botName: 'Bot A1',
            mode: 'periodic',
            backend: 'ollama',
            nextRunAt: 2000,
          },
          {
            botId: 'bot-a2',
            botName: 'Bot A2',
            mode: 'periodic',
            backend: 'ollama',
            nextRunAt: 3000,
          },
          {
            botId: 'bot-b1',
            botName: 'Bot B1',
            mode: 'periodic',
            backend: 'ollama',
            nextRunAt: 4000,
          },
        ],
      }),
      runAgentLoopAll: vi.fn(),
      runAgentLoop: vi.fn(),
      isRunning: vi.fn(),
      gracefulStopAll: vi.fn(),
      getLlmStats: vi.fn(),
    } as any;
  }

  it('tenant-A sees only their bots in schedules and results', async () => {
    const config = makeMultiTenantConfig();
    const app = new Hono();
    app.use('*', tenantMiddleware('tenant-A'));
    app.route(
      '/api/agent-loop',
      agentLoopRoutes({ config, botManager: makeBotManager(), logger: noopLogger })
    );

    const res = await app.request('/api/agent-loop');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.botSchedules).toHaveLength(2);
    expect(body.botSchedules.map((s: any) => s.botId)).toEqual(['bot-a1', 'bot-a2']);
    expect(body.lastResults).toHaveLength(1);
    expect(body.lastResults[0].botId).toBe('bot-a1');
  });

  it('admin sees all bots', async () => {
    const config = makeMultiTenantConfig();
    const app = new Hono();
    app.use('*', adminMiddleware());
    app.route(
      '/api/agent-loop',
      agentLoopRoutes({ config, botManager: makeBotManager(), logger: noopLogger })
    );

    const res = await app.request('/api/agent-loop');
    const body = (await res.json()) as any;
    expect(body.botSchedules).toHaveLength(3);
    expect(body.lastResults).toHaveLength(2);
  });

  it('no tenant context (single-tenant) sees all bots', async () => {
    const config = makeMultiTenantConfig();
    const app = new Hono();
    app.route(
      '/api/agent-loop',
      agentLoopRoutes({ config, botManager: makeBotManager(), logger: noopLogger })
    );

    const res = await app.request('/api/agent-loop');
    const body = (await res.json()) as any;
    expect(body.botSchedules).toHaveLength(3);
    expect(body.lastResults).toHaveLength(2);
  });
});

describe('1.2 status GET / — tenant scoping of bot IDs/counts', () => {
  function makeBotManager() {
    return {
      getBotIds: vi.fn().mockReturnValue(['bot-a1', 'bot-b1']),
    } as any;
  }

  it('tenant-A sees only their configured/running bots', async () => {
    const config = makeMultiTenantConfig();
    const app = new Hono();
    app.use('*', tenantMiddleware('tenant-A'));
    app.route('/api/status', statusRoutes({ config, botManager: makeBotManager() }));

    const res = await app.request('/api/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.bots.configured).toBe(2); // bot-a1, bot-a2
    expect(body.bots.running).toBe(1); // only bot-a1 is running
    expect(body.bots.ids).toEqual(['bot-a1']);
  });

  it('tenant-B sees only their configured/running bots', async () => {
    const config = makeMultiTenantConfig();
    const app = new Hono();
    app.use('*', tenantMiddleware('tenant-B'));
    app.route('/api/status', statusRoutes({ config, botManager: makeBotManager() }));

    const res = await app.request('/api/status');
    const body = (await res.json()) as any;
    expect(body.bots.configured).toBe(1);
    expect(body.bots.running).toBe(1);
    expect(body.bots.ids).toEqual(['bot-b1']);
  });

  it('admin sees all bots', async () => {
    const config = makeMultiTenantConfig();
    const app = new Hono();
    app.use('*', adminMiddleware());
    app.route('/api/status', statusRoutes({ config, botManager: makeBotManager() }));

    const res = await app.request('/api/status');
    const body = (await res.json()) as any;
    expect(body.bots.configured).toBe(3);
    expect(body.bots.running).toBe(2);
    expect(body.bots.ids).toEqual(['bot-a1', 'bot-b1']);
  });
});

describe('1.5 agent-proposals — tenant scoping', () => {
  const TEST_DIR = join(process.cwd(), '.test-proposal-tenant-scoping');

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  function makeApp(tenantId?: string) {
    const store = new AgentProposalStore(join(TEST_DIR, 'proposals'));
    const config = makeMultiTenantConfig();
    const configPath = join(TEST_DIR, 'config.json');
    writeFileSync(configPath, JSON.stringify({}, null, 2), 'utf-8');

    const app = new Hono();
    if (tenantId) {
      app.use('*', tenantMiddleware(tenantId));
    }
    app.route(
      '/api/agent-proposals',
      agentProposalRoutes({ store, config, configPath, logger: noopLogger })
    );
    return { app, store };
  }

  it('tenant-A sees only proposals from their bots', async () => {
    const { app, store } = makeApp('tenant-A');
    store.create({
      agentId: 'new-1',
      agentName: 'N1',
      role: 'r',
      personalityDescription: 'p',
      skills: [],
      justification: 'j',
      proposedBy: 'bot-a1',
    });
    store.create({
      agentId: 'new-2',
      agentName: 'N2',
      role: 'r',
      personalityDescription: 'p',
      skills: [],
      justification: 'j',
      proposedBy: 'bot-b1',
    });

    const res = await app.request('/api/agent-proposals');
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(1);
    expect(body[0].proposedBy).toBe('bot-a1');
  });

  it('GET /count only counts proposals from tenant bots', async () => {
    const { app, store } = makeApp('tenant-A');
    store.create({
      agentId: 'n1',
      agentName: 'N1',
      role: 'r',
      personalityDescription: 'p',
      skills: [],
      justification: 'j',
      proposedBy: 'bot-a1',
    });
    store.create({
      agentId: 'n2',
      agentName: 'N2',
      role: 'r',
      personalityDescription: 'p',
      skills: [],
      justification: 'j',
      proposedBy: 'bot-b1',
    });

    const res = await app.request('/api/agent-proposals/count');
    const body = (await res.json()) as any;
    expect(body.count).toBe(1); // Only from bot-a1
  });

  it('tenant cannot reject proposal from another tenant bot', async () => {
    const { app, store } = makeApp('tenant-A');
    const proposal = store.create({
      agentId: 'n1',
      agentName: 'N1',
      role: 'r',
      personalityDescription: 'p',
      skills: [],
      justification: 'j',
      proposedBy: 'bot-b1',
    });

    const res = await app.request(`/api/agent-proposals/${proposal.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it('tenant cannot delete proposal from another tenant bot', async () => {
    const { app, store } = makeApp('tenant-A');
    const proposal = store.create({
      agentId: 'n1',
      agentName: 'N1',
      role: 'r',
      personalityDescription: 'p',
      skills: [],
      justification: 'j',
      proposedBy: 'bot-b1',
    });

    const res = await app.request(`/api/agent-proposals/${proposal.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('admin sees all proposals', async () => {
    const { app, store } = makeApp('__admin__');
    store.create({
      agentId: 'n1',
      agentName: 'N1',
      role: 'r',
      personalityDescription: 'p',
      skills: [],
      justification: 'j',
      proposedBy: 'bot-a1',
    });
    store.create({
      agentId: 'n2',
      agentName: 'N2',
      role: 'r',
      personalityDescription: 'p',
      skills: [],
      justification: 'j',
      proposedBy: 'bot-b1',
    });

    const res = await app.request('/api/agent-proposals');
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(2);
  });
});

describe('1.7 dashboard /badges — tenant-scoped proposal count', () => {
  it('filters proposal count by tenant bot IDs', async () => {
    const config = makeMultiTenantConfig();
    const botManager = {
      getConversationsService: () => null,
      getAskHumanCount: () => 0,
      getAskHumanPending: () => [],
      getAgentFeedbackPendingCount: () => 0,
      getPermissionsCount: () => 0,
      getPermissionsPending: () => [],
      getAgentProposalStore: () => ({
        list: () => [
          { status: 'pending', proposedBy: 'bot-a1' },
          { status: 'pending', proposedBy: 'bot-b1' },
          { status: 'approved', proposedBy: 'bot-a1' },
        ],
      }),
    } as any;

    const app = new Hono();
    app.use('*', tenantMiddleware('tenant-A'));
    app.route('/api/dashboard', dashboardRoutes({ config, botManager, logger: noopLogger }));

    const res = await app.request('/api/dashboard/badges');
    const body = (await res.json()) as any;
    expect(body.agentProposals).toBe(1); // Only the pending one from bot-a1
  });
});

// ─── Group 2: Admin-only gates ──────────────────────────────────────────

describe('2.1 settings — admin-only', () => {
  const TEST_DIR = join(process.cwd(), '.test-settings-admin-gate');

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({}, null, 2));
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  function makeApp(tenantId?: string) {
    const config = makeMultiTenantConfig();
    const app = new Hono();
    if (tenantId) app.use('*', tenantMiddleware(tenantId));
    app.route(
      '/api/settings',
      settingsRoutes({
        config,
        configPath: join(TEST_DIR, 'config.json'),
        logger: noopLogger,
      })
    );
    return app;
  }

  it('returns 403 for non-admin tenant', async () => {
    const app = makeApp('tenant-A');
    const res = await app.request('/api/settings/session');
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe('Admin access required');
  });

  it('allows admin access', async () => {
    const app = makeApp('__admin__');
    const res = await app.request('/api/settings/session');
    expect(res.status).toBe(200);
  });

  it('allows single-tenant (no tenant context)', async () => {
    const app = makeApp();
    const res = await app.request('/api/settings/session');
    expect(res.status).toBe(200);
  });
});

describe('2.2 tools — admin-only', () => {
  function makeApp(tenantId?: string) {
    const app = new Hono();
    if (tenantId) app.use('*', tenantMiddleware(tenantId));
    app.route(
      '/api/tools',
      toolsRoutes({
        store: {
          list: () => [],
          get: () => null,
          delete: () => false,
          updateMeta: () => null,
        } as any,
        registry: {} as any,
      })
    );
    return app;
  }

  it('returns 403 for non-admin tenant', async () => {
    const app = makeApp('tenant-A');
    const res = await app.request('/api/tools');
    expect(res.status).toBe(403);
  });

  it('allows admin access', async () => {
    const app = makeApp('__admin__');
    const res = await app.request('/api/tools');
    expect(res.status).toBe(200);
  });

  it('allows single-tenant (no tenant context)', async () => {
    const app = makeApp();
    const res = await app.request('/api/tools');
    expect(res.status).toBe(200);
  });
});

describe('2.3 mcp — admin-only', () => {
  function makeApp(tenantId?: string) {
    const app = new Hono();
    if (tenantId) app.use('*', tenantMiddleware(tenantId));
    app.route(
      '/api/mcp',
      mcpRoutes({
        botManager: {
          getMcpClientPool: () => ({ getStatus: () => [], connectedCount: 0, size: 0 }),
        } as any,
        logger: noopLogger,
        getMcpServer: () => null,
      })
    );
    return app;
  }

  it('returns 403 for non-admin tenant', async () => {
    const app = makeApp('tenant-A');
    const res = await app.request('/api/mcp/servers');
    expect(res.status).toBe(403);
  });

  it('allows admin access', async () => {
    const app = makeApp('__admin__');
    const res = await app.request('/api/mcp/servers');
    expect(res.status).toBe(200);
  });

  it('allows single-tenant (no tenant context)', async () => {
    const app = makeApp();
    const res = await app.request('/api/mcp/servers');
    expect(res.status).toBe(200);
  });
});

describe('2.4 integrations — admin-only', () => {
  function makeApp(tenantId?: string) {
    const app = new Hono();
    if (tenantId) app.use('*', tenantMiddleware(tenantId));
    app.route(
      '/api/integrations',
      integrationsRoutes({
        config: makeMultiTenantConfig(),
        botManager: {
          getOllamaClient: () => ({}),
          getToolRegistry: () => ({ getDefinitions: () => [], getTools: () => [] }),
        } as any,
        logger: noopLogger,
      })
    );
    return app;
  }

  it('returns 403 for non-admin tenant', async () => {
    const app = makeApp('tenant-A');
    const res = await app.request('/api/integrations/ollama/status');
    expect(res.status).toBe(403);
  });

  it('allows admin access', async () => {
    const app = makeApp('__admin__');
    // Will try to connect to Ollama and may fail, but won't be 403
    const res = await app.request('/api/integrations/ollama/status');
    expect(res.status).not.toBe(403);
  });

  it('allows single-tenant (no tenant context)', async () => {
    const app = makeApp();
    const res = await app.request('/api/integrations/ollama/status');
    expect(res.status).not.toBe(403);
  });
});

// ─── isAdminOrSingleTenant helper ───────────────────────────────────────

describe('isAdminOrSingleTenant', () => {
  // Import directly to test the utility
  const { isAdminOrSingleTenant } = require('../../../src/tenant/tenant-scoping');

  it('returns true for undefined (single-tenant)', () => {
    expect(isAdminOrSingleTenant(undefined)).toBe(true);
  });

  it('returns true for __admin__', () => {
    expect(isAdminOrSingleTenant('__admin__')).toBe(true);
  });

  it('returns false for a regular tenant', () => {
    expect(isAdminOrSingleTenant('tenant-A')).toBe(false);
  });
});

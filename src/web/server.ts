import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync, watch } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { BotManager } from '../bot';
import type { Config } from '../config';
import type { SkillRegistry } from '../core/skill-registry';
import type { CronService } from '../cron';
import type { Logger } from '../logger';
import { McpServer } from '../mcp/server';
import type { SessionManager } from '../session';
import { AdminCredentialStore } from '../tenant/admin-credentials';
import { createAdminAuthMiddleware } from '../tenant/admin-middleware';
import { TenantManager } from '../tenant/manager';
import { createTenantAuthMiddleware } from '../tenant/middleware';
import { createRateLimitMiddleware } from '../tenant/rate-limit-middleware';
import { RateLimiter } from '../tenant/rate-limiter';
import { SessionStore } from '../tenant/session-store';
import { TenantConfigStore } from '../tenant/tenant-config-store';
import { agentExportRoutes } from './routes/agent-export';
import { agentFeedbackRoutes } from './routes/agent-feedback';
import { agentLoopRoutes } from './routes/agent-loop';
import { agentProposalRoutes } from './routes/agent-proposals';
import { agentsRoutes } from './routes/agents';
import { askHumanRoutes } from './routes/ask-human';
import { askPermissionRoutes } from './routes/ask-permission';
import { authRoutes } from './routes/auth';
import { billingRoutes } from './routes/billing';
import { conversationsRoutes } from './routes/conversations';
import { cronRoutes } from './routes/cron';
import { filesRoutes } from './routes/files';
import { integrationsRoutes } from './routes/integrations';
import { karmaRoutes } from './routes/karma';
import { mcpRoutes } from './routes/mcp';
import { onboardingRoutes } from './routes/onboarding';
import { productionsRoutes } from './routes/productions';
import { sessionsRoutes } from './routes/sessions';
import { settingsRoutes } from './routes/settings';
import { skillsRoutes } from './routes/skills';
import { statusRoutes } from './routes/status';
import { tenantConfigRoutes } from './routes/tenant-config';
import { tenantRoutes } from './routes/tenants';
import { toolsRoutes } from './routes/tools';
import { webhookRoutes } from './routes/webhooks';

export type WebServerDeps = {
  config: Config;
  configPath: string;
  logger: Logger;
  botManager: BotManager;
  sessionManager: SessionManager;
  skillRegistry: SkillRegistry;
  cronService: CronService;
};

export function startWebServer(deps: WebServerDeps): void {
  const { config, logger } = deps;
  const { port, host } = config.web;

  const app = new Hono();

  // --- Session & credential stores ---
  const dataDir = config.multiTenant?.dataDir ?? './data/tenants';
  const sessionStore = new SessionStore();
  const adminCredentialStore = new AdminCredentialStore(dataDir);

  // --- Multi-tenant API auth middleware (must be registered BEFORE routes) ---
  let tenantManager: TenantManager | null = null;
  if (config.multiTenant?.enabled) {
    tenantManager = new TenantManager({ dataDir }, logger);
    const tenantAuth = createTenantAuthMiddleware(tenantManager, logger, sessionStore);

    // Apply tenant auth to regular API routes (skip public, admin, auth, and tenant-specific endpoints)
    app.use('/api/*', async (c, next) => {
      const path = c.req.path;
      if (
        path === '/api/status' ||
        path.startsWith('/api/auth/') ||
        path.startsWith('/api/admin/') ||
        path === '/api/tenants' ||
        path.startsWith('/api/tenant/')
      ) {
        return next();
      }
      return tenantAuth(c, next);
    });

    // Rate limiting for tenant API requests
    const rateLimiter = new RateLimiter();
    const rateLimitMw = createRateLimitMiddleware(rateLimiter, tenantManager, logger);
    app.use('/api/*', rateLimitMw);

    // Periodic cleanup of expired rate limit entries + sessions (every 5 minutes)
    setInterval(() => {
      rateLimiter.cleanup();
      sessionStore.cleanup();
    }, 5 * 60_000);

    logger.info('Multi-tenant API authentication and rate limiting enabled');
  }

  // API routes
  app.route('/api/status', statusRoutes({ config, botManager: deps.botManager }));
  app.route(
    '/api/auth',
    authRoutes({ config, tenantManager, sessionStore, adminCredentialStore, logger })
  );
  app.route(
    '/api/skills',
    skillsRoutes({
      skillRegistry: deps.skillRegistry,
      config,
      configPath: deps.configPath,
      botManager: deps.botManager,
      logger,
    })
  );
  app.route(
    '/api/agents',
    agentsRoutes({ config, botManager: deps.botManager, configPath: deps.configPath, logger })
  );
  app.route(
    '/api/agents',
    agentExportRoutes({
      config,
      configPath: deps.configPath,
      botManager: deps.botManager,
      logger,
      memoryManager: deps.botManager.getMemoryManager(),
    })
  );
  app.route('/api/sessions', sessionsRoutes({ sessionManager: deps.sessionManager }));
  app.route('/api/cron', cronRoutes({ cronService: deps.cronService }));
  app.route(
    '/api/settings',
    settingsRoutes({ config, configPath: deps.configPath, logger, botManager: deps.botManager })
  );
  app.route('/api/agent-loop', agentLoopRoutes({ config, botManager: deps.botManager, logger }));
  app.route(
    '/api/ask-human',
    askHumanRoutes({
      botManager: deps.botManager,
      logger,
      conversationsService: deps.botManager.getConversationsService(),
      config,
    })
  );
  app.route(
    '/api/ask-permission',
    askPermissionRoutes({ botManager: deps.botManager, logger, config })
  );
  app.route(
    '/api/agent-feedback',
    agentFeedbackRoutes({
      config,
      botManager: deps.botManager,
      logger,
      productionsService: deps.botManager.getProductionsService(),
    })
  );

  app.route(
    '/api/integrations',
    integrationsRoutes({ config, botManager: deps.botManager, logger })
  );
  app.route('/api/files', filesRoutes({ config, logger }));

  // Productions routes (only if enabled)
  const productionsService = deps.botManager.getProductionsService();
  if (productionsService) {
    app.route(
      '/api/productions',
      productionsRoutes({ productionsService, botManager: deps.botManager, logger, config })
    );
  }

  // Karma routes (only if enabled)
  const karmaService = deps.botManager.getKarmaService();
  if (karmaService) {
    app.route('/api/karma', karmaRoutes({ karmaService, config, logger }));
  }

  // Conversations routes (use shared ConversationsService from BotManager)
  const conversationsService = deps.botManager.getConversationsService();
  app.route(
    '/api/conversations',
    conversationsRoutes({
      conversationsService,
      botManager: deps.botManager,
      logger,
      config,
      productionsService,
    })
  );

  // Dynamic tools routes (only if enabled)
  const dynamicStore = deps.botManager.getDynamicToolStore();
  const dynamicRegistry = deps.botManager.getDynamicToolRegistry();
  if (dynamicStore && dynamicRegistry) {
    app.route(
      '/api/tools',
      toolsRoutes({
        store: dynamicStore,
        registry: dynamicRegistry,
        botManager: deps.botManager,
        logger,
      })
    );
  }

  // Agent proposal routes (only if enabled)
  const agentProposalStore = deps.botManager.getAgentProposalStore();
  if (agentProposalStore) {
    app.route(
      '/api/agent-proposals',
      agentProposalRoutes({
        store: agentProposalStore,
        config,
        configPath: deps.configPath,
        logger,
      })
    );
  }

  // MCP routes (exposed server + client status)
  let mcpServer: McpServer | null = null;
  const mcpExposeConfig = config.mcp?.expose;
  if (mcpExposeConfig?.enabled) {
    const toolRegistry = deps.botManager.getToolRegistry();
    mcpServer = new McpServer({
      config: {
        enabled: mcpExposeConfig.enabled,
        port: mcpExposeConfig.port,
        host: mcpExposeConfig.host,
        exposedTools: mcpExposeConfig.exposedTools,
        hiddenTools: mcpExposeConfig.hiddenTools,
        authToken: mcpExposeConfig.authToken,
        maxCallsPerMinute: mcpExposeConfig.maxCallsPerMinute,
      },
      getTools: () => toolRegistry.getTools(),
      getDefinitions: () => toolRegistry.getDefinitions(),
      executeTool: async (name, args) => {
        const tool = toolRegistry.getTools().find((t) => t.definition.function.name === name);
        if (!tool) return { success: false, content: `Tool not found: ${name}` };
        return tool.execute(args, logger);
      },
      logger,
    });

    // Auto-start the exposed server
    mcpServer.start().catch((err) => {
      logger.warn({ err }, 'Failed to auto-start MCP exposed server');
    });
  }

  app.route(
    '/api/mcp',
    mcpRoutes({
      botManager: deps.botManager,
      logger,
      getMcpServer: () => mcpServer,
    })
  );

  // --- Multi-tenant routes (only when enabled) ---
  if (tenantManager && config.multiTenant?.enabled) {
    const adminAuth = createAdminAuthMiddleware(logger, sessionStore);
    const tenantAuthForSelfService = createTenantAuthMiddleware(
      tenantManager,
      logger,
      sessionStore
    );
    const tenantConfigStore = new TenantConfigStore(config.multiTenant.dataDir ?? './data/tenants');

    // Tenant config routes (protected by global tenant auth middleware)
    app.route('/api/tenant-config', tenantConfigRoutes({ configStore: tenantConfigStore, logger }));

    const routeDeps = {
      tenantManager: tenantManager!,
      botManager: deps.botManager,
      config,
      logger,
      sessionStore,
    };

    // Public: tenant signup + onboarding signup
    app.post('/api/tenants', async (c) => {
      const routes = tenantRoutes(routeDeps);
      return routes.fetch(
        new Request(c.req.url, {
          method: 'POST',
          body: await c.req.text(),
          headers: c.req.raw.headers,
        })
      );
    });
    app.route('/api/onboarding', onboardingRoutes(routeDeps));

    // Public: Stripe webhook (no auth needed, verified by signature)
    app.route('/api/webhooks', webhookRoutes({ botManager: deps.botManager, logger }));

    // Tenant-auth protected: tenant self-service
    const tenantSelfService = new Hono();
    tenantSelfService.use('*', tenantAuthForSelfService);
    tenantSelfService.route('/', tenantRoutes(routeDeps));
    app.route('/api/tenant', tenantSelfService);

    // Tenant-auth protected: billing
    const billingApp = new Hono();
    billingApp.use('*', tenantAuthForSelfService);
    billingApp.route('/', billingRoutes(routeDeps));
    app.route('/api/billing', billingApp);

    // Admin-auth protected: tenant management
    const adminTenantRoutes = new Hono();
    adminTenantRoutes.use('*', adminAuth);
    adminTenantRoutes.route('/tenants', tenantRoutes(routeDeps));
    app.route('/api/admin', adminTenantRoutes);

    logger.info('Multi-tenant routes mounted (with billing, onboarding, webhooks)');
  }

  // --- Activity stream REST endpoint ---
  const activityStream = deps.botManager.getActivityStream();
  app.get('/api/activity', (c) => {
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') || '50')), 500);
    const offset = Math.max(0, Number(c.req.query('offset') || '0'));
    return c.json(activityStream.getSlice(limit, offset));
  });

  // --- System logs REST endpoint (paginated) ---
  app.get('/api/logs', (c) => {
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') || '100')), 1000);
    const offset = Math.max(0, Number(c.req.query('offset') || '0'));
    try {
      const text = readFileSync(logFile, 'utf-8') as string;
      const allLines = text.trimEnd().split('\n').filter(Boolean);
      const total = allLines.length;
      const end = total - offset;
      const start = Math.max(0, end - limit);
      if (end <= 0) return c.json({ lines: [], total });
      const slice = allLines.slice(start, end);
      const parsed: unknown[] = [];
      for (const line of slice) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          /* skip malformed */
        }
      }
      return c.json({ lines: parsed, total });
    } catch {
      return c.json({ lines: [], total: 0 });
    }
  });

  // Static files from web/ directory
  app.use('/*', serveStatic({ root: './web' }));

  // Fallback: serve index.html for SPA routing
  app.get('*', serveStatic({ root: './web', path: '/index.html' }));

  // --- WebSocket log streaming ---
  const logFile = config.logging?.file || './data/logs/aibot.log';
  type WsData = { type: string };
  const wsClients = new Set<ServerWebSocket<WsData>>();
  const activityClients = new Set<ServerWebSocket<WsData>>();
  let fileOffset = 0;

  function readLastLines(path: string, maxLines: number): string[] {
    try {
      const text = readFileSync(path, 'utf-8') as string;
      const lines = text.trimEnd().split('\n');
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }

  function getFileSize(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  function broadcast(data: string) {
    for (const ws of wsClients) {
      try {
        ws.send(data);
      } catch (err) {
        logger.debug({ err }, 'WebSocket log broadcast send failed, removing client');
        wsClients.delete(ws);
      }
    }
  }

  function broadcastActivity(data: string) {
    for (const ws of activityClients) {
      try {
        ws.send(data);
      } catch (err) {
        logger.debug({ err }, 'WebSocket activity broadcast send failed, removing client');
        activityClients.delete(ws);
      }
    }
  }

  // Subscribe to activity stream for WebSocket broadcasting
  activityStream.on('activity', (event: unknown) => {
    broadcastActivity(JSON.stringify({ type: 'activity', event }));
  });

  // Initialize offset to current file size
  fileOffset = getFileSize(logFile);

  // Watch log file for changes
  try {
    watch(logFile, () => {
      try {
        const fd = openSync(logFile, 'r');
        const stat = fstatSync(fd);
        const newSize = stat.size;

        if (newSize <= fileOffset) {
          // File was truncated/rotated — reset
          fileOffset = 0;
        }

        if (newSize > fileOffset) {
          const buf = Buffer.alloc(newSize - fileOffset);
          readSync(fd, buf, 0, buf.length, fileOffset);
          fileOffset = newSize;
          closeSync(fd);

          const chunk = buf.toString('utf-8');
          const rawLines = chunk.trimEnd().split('\n');
          const parsed: unknown[] = [];
          for (const line of rawLines) {
            if (!line) continue;
            try {
              parsed.push(JSON.parse(line));
            } catch {
              /* skip malformed */
            }
          }
          if (parsed.length > 0) {
            broadcast(JSON.stringify({ type: 'logs', lines: parsed }));
          }
        } else {
          closeSync(fd);
        }
      } catch {
        /* ignore read errors */
      }
    });
  } catch {
    logger.warn('Could not watch log file for live streaming');
  }

  Bun.serve<WsData>({
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/ws/logs' || url.pathname === '/ws/activity') {
        // Authenticate WebSocket connections in multi-tenant mode
        if (config.multiTenant?.enabled) {
          const token = url.searchParams.get('token');
          if (!token) return new Response('Unauthorized', { status: 401 });
          // Accept session tokens
          if (token.startsWith('sess_')) {
            const session = sessionStore.getSession(token);
            if (!session) return new Response('Unauthorized', { status: 401 });
          } else {
            const adminKey = process.env.ADMIN_API_KEY;
            const isAdmin = adminKey && token === adminKey;
            const isTenant = tenantManager?.getTenantByApiKey(token);
            if (!isAdmin && !isTenant) return new Response('Unauthorized', { status: 401 });
          }
        }
        const wsType = url.pathname === '/ws/activity' ? 'activity' : 'logs';
        const ok = server.upgrade(req, { data: { type: wsType } });
        if (ok) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return app.fetch(req, server);
    },
    port,
    hostname: host,
    idleTimeout: 255,
    websocket: {
      open(ws) {
        if (ws.data?.type === 'activity') {
          activityClients.add(ws);
          logger.debug(
            { clientCount: activityClients.size },
            'WebSocket activity client connected'
          );
          // Send recent activity events as history
          const recent = activityStream.getRecent(50);
          ws.send(JSON.stringify({ type: 'history', events: recent }));
        } else {
          wsClients.add(ws);
          logger.debug({ clientCount: wsClients.size }, 'WebSocket logs client connected');
          // Send last 100 lines as history
          const historyLines = readLastLines(logFile, 100);
          const parsed: unknown[] = [];
          for (const line of historyLines) {
            try {
              parsed.push(JSON.parse(line));
            } catch {
              /* skip */
            }
          }
          ws.send(JSON.stringify({ type: 'history', lines: parsed }));
        }
      },
      message() {
        // No client->server messages needed
      },
      close(ws) {
        if (ws.data?.type === 'activity') {
          activityClients.delete(ws);
          logger.debug(
            { clientCount: activityClients.size },
            'WebSocket activity client disconnected'
          );
        } else {
          wsClients.delete(ws);
          logger.debug({ clientCount: wsClients.size }, 'WebSocket logs client disconnected');
        }
      },
    },
  });

  logger.info({ port, host }, `Web UI available at http://${host}:${port}`);
}

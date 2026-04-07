import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  watch,
} from 'node:fs';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { A2AServer } from '../a2a/server';
import type { BotManager } from '../bot';
import { describeToolCall } from '../bot/inline-approval';
import { wsChannel, wsToInbound } from '../channel/websocket';
import type { WsChatData } from '../channel/websocket';
import type { Config } from '../config';
import type { SkillRegistry } from '../core/skill-registry';
import type { CronService } from '../cron';
import { safeCompare } from '../crypto-utils';
import type { Logger } from '../logger';
import { McpServer } from '../mcp/server';
import type { SessionManager } from '../session';
import { AdminCredentialStore } from '../tenant/admin-credentials';
import { createAdminAuthMiddleware } from '../tenant/admin-middleware';
import { verifyUserIdentity } from '../tenant/identity-verification';
import { TenantManager } from '../tenant/manager';
import { createTenantAuthMiddleware } from '../tenant/middleware';
import { createRateLimitMiddleware } from '../tenant/rate-limit-middleware';
import { RateLimiter } from '../tenant/rate-limiter';
import { SessionStore } from '../tenant/session-store';
import { TenantConfigStore } from '../tenant/tenant-config-store';
import { getTenantId, scopeBots } from '../tenant/tenant-scoping';
import { agentExportRoutes } from './routes/agent-export';
import { agentFeedbackRoutes } from './routes/agent-feedback';
import { agentLoopRoutes } from './routes/agent-loop';
import { agentProposalRoutes } from './routes/agent-proposals';
import { agentsRoutes } from './routes/agents';
import { analyticsRoutes } from './routes/analytics';
import { askHumanRoutes } from './routes/ask-human';
import { askPermissionRoutes } from './routes/ask-permission';
import { authRoutes } from './routes/auth';
import { baasRoutes } from './routes/baas';
import { billingRoutes } from './routes/billing';
import { chatRoutes } from './routes/chat';
import { chatHistoryRoutes } from './routes/chat-history';
import { conversationsRoutes } from './routes/conversations';
import { cronRoutes } from './routes/cron';
import { dashboardRoutes } from './routes/dashboard';
import { filesRoutes } from './routes/files';
import { integrationsRoutes } from './routes/integrations';
import { karmaRoutes } from './routes/karma';
import { mcpRoutes } from './routes/mcp';
import { onboardingRoutes } from './routes/onboarding';
import { productionsRoutes } from './routes/productions';
import { sessionsRoutes } from './routes/sessions';
import { settingsRoutes } from './routes/settings';
import { skillCommandRoutes } from './routes/skill-commands';
import { skillsRoutes } from './routes/skills';
import { statusRoutes } from './routes/status';
import { tenantConfigRoutes } from './routes/tenant-config';
import { tenantRoutes } from './routes/tenants';
import { toolsRoutes } from './routes/tools';
import { webhookRoutes } from './routes/webhooks';
import { whatsappWebhookRoutes } from './routes/whatsapp-webhook';

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
        path.startsWith('/api/tenant/') ||
        path.startsWith('/api/onboarding/')
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
  app.route(
    '/api/v1/chat',
    chatRoutes({ config, botManager: deps.botManager, logger, tenantManager })
  );
  app.route(
    '/api/v1/chat',
    chatHistoryRoutes({ config, sessionManager: deps.sessionManager, logger })
  );
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
    agentsRoutes({
      config,
      botManager: deps.botManager,
      skillRegistry: deps.skillRegistry,
      configPath: deps.configPath,
      logger,
    })
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
  app.route(
    '/api/agents',
    skillCommandRoutes({
      config,
      botManager: deps.botManager,
      skillRegistry: deps.skillRegistry,
      logger,
    })
  );
  app.route('/api/sessions', sessionsRoutes({ sessionManager: deps.sessionManager, config }));
  app.route('/api/cron', cronRoutes({ cronService: deps.cronService, config }));
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

  app.route('/api/dashboard', dashboardRoutes({ config, botManager: deps.botManager, logger }));
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

    // Static file serving for production index.html and its file links
    app.get('/productions-view/:botId/*', (c) => {
      const botId = c.req.param('botId');
      const filePath = c.req.param('*') || 'index.html';

      if (filePath.includes('..') || filePath.startsWith('/')) {
        return c.text('Forbidden', 403);
      }

      const dir = productionsService.resolveDir(botId);
      const fullPath = resolvePath(joinPath(dir, filePath));

      if (!fullPath.startsWith(dir)) {
        return c.text('Forbidden', 403);
      }

      if (!existsSync(fullPath)) {
        return c.text('Not Found', 404);
      }
      try {
        const stat = statSync(fullPath);
        if (!stat.isFile()) return c.text('Not Found', 404);
      } catch {
        return c.text('Not Found', 404);
      }

      const MIME_TYPES: Record<string, string> = {
        html: 'text/html; charset=utf-8',
        htm: 'text/html; charset=utf-8',
        css: 'text/css; charset=utf-8',
        js: 'text/javascript; charset=utf-8',
        json: 'application/json; charset=utf-8',
        md: 'text/markdown; charset=utf-8',
        txt: 'text/plain; charset=utf-8',
        csv: 'text/csv; charset=utf-8',
        xml: 'application/xml; charset=utf-8',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        pdf: 'application/pdf',
      };
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      const content = readFileSync(fullPath);
      return new Response(content, {
        headers: { 'Content-Type': contentType },
      });
    });
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

  // --- A2A Protocol server (agent-to-agent communication) ---
  if (config.a2a?.enabled) {
    const toolRegistry = deps.botManager.getToolRegistry();
    const a2aServer = new A2AServer(
      config.bots.map((b) => b.id),
      (botId: string) => {
        const bot = config.bots.find((b) => b.id === botId);
        if (!bot) return null;
        const webHost = config.web.host === '0.0.0.0' ? '127.0.0.1' : config.web.host;
        return {
          baseUrl: `http://${webHost}:${config.web.port}`,
          botConfig: bot,
          toolDefinitions: toolRegistry.getDefinitions(),
        };
      },
      {
        getLLMClient: (botId: string) => deps.botManager.getLLMClient(botId),
        getSystemPrompt: (botId: string) => deps.botManager.getSystemPrompt(botId),
      },
      logger,
      {
        basePath: config.a2a.basePath,
        maxTasks: config.a2a.maxTasks,
        taskTtlMs: config.a2a.taskTtlMs,
      }
    );
    a2aServer.mount(app, config.a2a.basePath);
    logger.info({ basePath: config.a2a.basePath }, 'A2A protocol server mounted');
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
      tenantManager: tenantManager,
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

    // BaaS routes: templates, customizations, webhooks management
    app.route('/api/baas', baasRoutes(deps.botManager));

    // Analytics routes (tenant-scoped)
    const analyticsService = deps.botManager.getAnalyticsService();
    if (analyticsService) {
      app.route('/api/baas/analytics', analyticsRoutes(analyticsService));
    }

    logger.info(
      'Multi-tenant routes mounted (with billing, onboarding, webhooks, BaaS, analytics)'
    );
  }

  // --- WhatsApp Business API webhook (public — Meta sends webhooks here) ---
  app.route(
    '/api/whatsapp',
    whatsappWebhookRoutes({ config, botManager: deps.botManager, logger })
  );

  // --- OpenAPI spec ---
  app.get('/api/v1/openapi.json', (c) => {
    try {
      const spec = readFileSync('./web/openapi.json', 'utf-8');
      return c.json(JSON.parse(spec));
    } catch {
      return c.json({ error: 'OpenAPI spec not found' }, 404);
    }
  });

  // --- Activity stream REST endpoint ---
  const activityStream = deps.botManager.getActivityStream();
  app.get('/api/activity', (c) => {
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') || '50')), 500);
    const offset = Math.max(0, Number(c.req.query('offset') || '0'));
    const tenantId = getTenantId(c);
    const slice = activityStream.getSlice(limit, offset);
    let events = slice.events;
    if (tenantId && tenantId !== '__admin__') {
      const allowedIds = new Set(scopeBots(config.bots, tenantId).map((b) => b.id));
      events = events.filter((e) => allowedIds.has(e.botId));
    }
    return c.json({ events, total: slice.total });
  });

  // --- System logs REST endpoint (paginated, admin-only in multi-tenant) ---
  app.get('/api/logs', (c) => {
    const tenantId = getTenantId(c);
    if (tenantId && tenantId !== '__admin__') {
      return c.json({ error: 'Admin access required' }, 403);
    }
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

  // --- WebSocket log streaming + chat ---
  const logFile = config.logging?.file || './data/logs/aibot.log';
  type WsData = {
    type: string;
    botId?: string;
    chatId?: string;
    senderId?: string;
    senderName?: string;
  };
  const wsClients = new Set<ServerWebSocket<WsData>>();
  const activityClients = new Set<ServerWebSocket<WsData>>();
  const chatClients = new Set<ServerWebSocket<WsData>>();
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
            const isAdmin = safeCompare(token, adminKey);
            const isTenant = tenantManager?.getTenantByApiKey(token);
            if (!isAdmin && !isTenant) return new Response('Unauthorized', { status: 401 });
          }
        }
        const wsType = url.pathname === '/ws/activity' ? 'activity' : 'logs';
        const ok = server.upgrade(req, { data: { type: wsType } });
        if (ok) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // WebSocket chat for embeddable widget: /ws/chat?botId=X&chatId=Y&senderId=Z
      if (url.pathname === '/ws/chat') {
        const botId = url.searchParams.get('botId');
        if (!botId) return new Response('Missing botId parameter', { status: 400 });

        const bot = config.bots.find((b) => b.id === botId);
        if (!bot) return new Response('Bot not found', { status: 404 });

        // In multi-tenant mode, authenticate via token param
        if (config.multiTenant?.enabled) {
          const token = url.searchParams.get('token');
          if (!token) return new Response('Unauthorized', { status: 401 });
          const tenant = tenantManager?.getTenantByApiKey(token);
          if (!tenant) return new Response('Unauthorized', { status: 401 });
          // Verify bot belongs to this tenant
          if (bot.tenantId && bot.tenantId !== tenant.id) {
            return new Response('Bot not found', { status: 404 });
          }

          // Identity verification for widget/REST
          const identityConfig = bot.userIdentityVerification;
          const identityRequired =
            identityConfig?.required ||
            (config.multiTenant?.enabled && identityConfig?.enabled !== false);

          if (identityRequired || identityConfig?.enabled) {
            const userHash = url.searchParams.get('userHash');
            const senderIdParam = url.searchParams.get('senderId');

            if (tenant?.identitySecret && senderIdParam) {
              if (!userHash) {
                if (identityConfig?.required) {
                  return new Response('Missing userHash for identity verification', {
                    status: 403,
                  });
                }
                // Not required: allow as anonymous (no per-user isolation)
              } else {
                if (!verifyUserIdentity(tenant.identitySecret, senderIdParam, userHash)) {
                  return new Response('Invalid user identity', { status: 403 });
                }
              }
            }
          }
        }

        const chatId = url.searchParams.get('chatId') || `widget-${Date.now()}`;
        const senderId = url.searchParams.get('senderId') || `anon-${Date.now()}`;
        const senderName = url.searchParams.get('senderName') || undefined;

        const ok = server.upgrade(req, {
          data: { type: 'chat', botId, chatId, senderId, senderName },
        });
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
        if (ws.data?.type === 'chat') {
          chatClients.add(ws);
          logger.debug(
            { clientCount: chatClients.size, botId: ws.data.botId, chatId: ws.data.chatId },
            'WebSocket chat client connected'
          );
          ws.send(JSON.stringify({ type: 'connected', botId: ws.data.botId }));
        } else if (ws.data?.type === 'activity') {
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
      async message(ws, raw) {
        // Chat WebSocket messages
        if (ws.data?.type === 'chat') {
          // biome-ignore lint/style/noNonNullAssertion: botId is guaranteed set during ws upgrade
          const botId = ws.data.botId!;
          let parsed: {
            type?: string;
            action?: string;
            message?: string;
            images?: string[];
            documents?: { name: string; mimeType: string; content: string }[];
          };
          try {
            parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
          } catch {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
            return;
          }

          // Handle approval responses from widget
          if (parsed.type === 'approval_response') {
            const action = parsed.action;
            if (action !== 'approve' && action !== 'deny') {
              ws.send(JSON.stringify({ type: 'error', error: 'Invalid approval action' }));
              return;
            }
            // Session key must match the one used by ConversationPipeline
            const senderId = ws.data.senderId ?? '';
            const sessionKey = `bot:${botId}:private:${Number(senderId) || 0}`;
            const store = deps.botManager.getInlineApprovalStore();
            const pending = store.consumePending(sessionKey);
            if (!pending) {
              ws.send(JSON.stringify({ type: 'error', error: 'No pending approval' }));
              return;
            }
            if (action === 'approve') {
              try {
                const toolRegistry = deps.botManager.getToolRegistry();
                const executor = toolRegistry.createExecutor(0, botId);
                const result = await executor(pending.toolName, pending.args);
                const resultText = result.content ?? JSON.stringify(result);
                ws.send(
                  JSON.stringify({
                    type: 'approval_result',
                    content: `Tool \`${pending.toolName}\` executed:\n${resultText}`,
                  })
                );
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : 'Unknown error';
                ws.send(
                  JSON.stringify({
                    type: 'approval_result',
                    content: `Tool \`${pending.toolName}\` failed: ${errMsg}`,
                  })
                );
              }
            } else {
              ws.send(
                JSON.stringify({
                  type: 'approval_result',
                  content: `Tool \`${pending.toolName}\` was denied.`,
                })
              );
            }
            return;
          }

          if (parsed.type !== 'message' || !parsed.message?.trim()) {
            ws.send(
              JSON.stringify({ type: 'error', error: 'Send { type: "message", message: "..." }' })
            );
            return;
          }

          // Validate images: max 4, max 10MB total base64 payload
          let images: string[] | undefined;
          if (Array.isArray(parsed.images) && parsed.images.length > 0) {
            if (parsed.images.length > 4) {
              ws.send(JSON.stringify({ type: 'error', error: 'Maximum 4 images per message' }));
              return;
            }
            const totalBytes = parsed.images.reduce(
              (sum, img) => sum + (typeof img === 'string' ? img.length : 0),
              0
            );
            if (totalBytes > 10 * 1024 * 1024) {
              ws.send(
                JSON.stringify({ type: 'error', error: 'Total image payload exceeds 10MB limit' })
              );
              return;
            }
            images = parsed.images.filter(
              (img): img is string => typeof img === 'string' && img.length > 0
            );
          }

          // Process documents: extract text and prepend to message
          let messageText = parsed.message.trim();
          if (Array.isArray(parsed.documents) && parsed.documents.length > 0) {
            const ALLOWED_DOC_MIME_TYPES = new Set([
              'application/pdf',
              'text/plain',
              'text/markdown',
              'text/csv',
              'text/html',
              'application/json',
            ]);
            const docs = parsed.documents.slice(0, 4);
            const textParts: string[] = [];
            for (const doc of docs) {
              if (!doc.name || !doc.mimeType || !doc.content) continue;
              if (!ALLOWED_DOC_MIME_TYPES.has(doc.mimeType)) continue;
              if (doc.content.length > 50_000) continue;
              try {
                let text: string;
                if (doc.mimeType === 'application/pdf') {
                  const buffer = Buffer.from(doc.content, 'base64');
                  // @ts-ignore -- pdf-parse has no type declarations
                  const pdfParse = (await import('pdf-parse')).default;
                  const data = (await pdfParse(buffer)) as { text: string };
                  text = data.text;
                } else {
                  text = doc.content;
                }
                const truncated =
                  text.length > 50_000 ? `${text.slice(0, 50_000)}\n... [truncated]` : text;
                textParts.push(`Content of "${doc.name}":\n\n${truncated}`);
              } catch (err) {
                logger.warn({ err, docName: doc.name }, 'WS: Failed to extract document text');
              }
            }
            if (textParts.length > 0) {
              messageText = `${textParts.join('\n\n---\n\n')}\n\n---\n\n${messageText}`;
            }
          }

          const chatData: WsChatData = {
            type: 'chat',
            botId,
            // biome-ignore lint/style/noNonNullAssertion: chatId is guaranteed set during ws upgrade
            chatId: ws.data.chatId!,
            // biome-ignore lint/style/noNonNullAssertion: senderId is guaranteed set during ws upgrade
            senderId: ws.data.senderId!,
            senderName: ws.data.senderName,
          };

          const msg = wsToInbound(chatData, messageText, images);
          const channel = wsChannel(ws as unknown as import('bun').ServerWebSocket<WsChatData>);

          deps.botManager
            .handleChannelMessage(msg, channel, botId)
            .then(() => {
              // After pipeline completes, check if a confirm-level tool is pending approval
              const approvalSessionKey = `bot:${botId}:private:${Number(ws.data.senderId) || 0}`;
              const store = deps.botManager.getInlineApprovalStore();
              const pending = store.getPending(approvalSessionKey);
              if (pending) {
                try {
                  ws.send(
                    JSON.stringify({
                      type: 'message',
                      role: 'bot',
                      content: '',
                      approval: {
                        toolName: pending.toolName,
                        description: describeToolCall(pending.toolName, pending.args),
                      },
                    })
                  );
                } catch {
                  /* connection closed */
                }
              }
            })
            .catch((err) => {
              logger.error({ err, botId, chatId: ws.data.chatId }, 'WebSocket chat handler failed');
              try {
                ws.send(JSON.stringify({ type: 'error', error: 'Failed to generate response' }));
              } catch {
                /* connection closed */
              }
            });
        }
        // No client->server messages needed for logs/activity
      },
      close(ws) {
        if (ws.data?.type === 'chat') {
          chatClients.delete(ws);
          logger.debug(
            { clientCount: chatClients.size, botId: ws.data.botId },
            'WebSocket chat client disconnected'
          );
        } else if (ws.data?.type === 'activity') {
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

import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync, watch } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { BotManager } from '../bot';
import type { Config } from '../config';
import type { SkillRegistry } from '../core/skill-registry';
import type { CronService } from '../cron';
import type { Logger } from '../logger';
import type { SessionManager } from '../session';
import { agentFeedbackRoutes } from './routes/agent-feedback';
import { agentLoopRoutes } from './routes/agent-loop';
import { agentsRoutes } from './routes/agents';
import { askHumanRoutes } from './routes/ask-human';
import { askPermissionRoutes } from './routes/ask-permission';
import { conversationsRoutes } from './routes/conversations';
import { cronRoutes } from './routes/cron';
import { filesRoutes } from './routes/files';
import { integrationsRoutes } from './routes/integrations';
import { karmaRoutes } from './routes/karma';
import { productionsRoutes } from './routes/productions';
import { sessionsRoutes } from './routes/sessions';
import { settingsRoutes } from './routes/settings';
import { skillsRoutes } from './routes/skills';
import { statusRoutes } from './routes/status';
import { toolsRoutes } from './routes/tools';

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

  // API routes
  app.route('/api/status', statusRoutes({ config, botManager: deps.botManager }));
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
  app.route('/api/sessions', sessionsRoutes({ sessionManager: deps.sessionManager }));
  app.route('/api/cron', cronRoutes({ cronService: deps.cronService }));
  app.route('/api/settings', settingsRoutes({ config, configPath: deps.configPath, logger }));
  app.route('/api/agent-loop', agentLoopRoutes({ config, botManager: deps.botManager, logger }));
  app.route(
    '/api/ask-human',
    askHumanRoutes({
      botManager: deps.botManager,
      logger,
      conversationsService: deps.botManager.getConversationsService(),
    })
  );
  app.route('/api/ask-permission', askPermissionRoutes({ botManager: deps.botManager, logger }));
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

  // Static files from web/ directory
  app.use('/*', serveStatic({ root: './web' }));

  // Fallback: serve index.html for SPA routing
  app.get('*', serveStatic({ root: './web', path: '/index.html' }));

  // --- Activity stream REST endpoint ---
  const activityStream = deps.botManager.getActivityStream();
  app.get('/api/activity', (c) => {
    const count = Number(c.req.query('count') || '50');
    return c.json(activityStream.getRecent(count));
  });

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
      } catch {
        wsClients.delete(ws);
      }
    }
  }

  function broadcastActivity(data: string) {
    for (const ws of activityClients) {
      try {
        ws.send(data);
      } catch {
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
      if (url.pathname === '/ws/logs') {
        const ok = server.upgrade(req, { data: { type: 'logs' } });
        if (ok) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      if (url.pathname === '/ws/activity') {
        const ok = server.upgrade(req, { data: { type: 'activity' } });
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
          // Send recent activity events as history
          const recent = activityStream.getRecent(50);
          ws.send(JSON.stringify({ type: 'history', events: recent }));
        } else {
          wsClients.add(ws);
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
        } else {
          wsClients.delete(ws);
        }
      },
    },
  });

  logger.info({ port, host }, `Web UI available at http://${host}:${port}`);
}

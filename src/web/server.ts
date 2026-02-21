import { watch } from 'fs';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { ServerWebSocket } from 'bun';
import type { BotManager } from '../bot';
import type { Config } from '../config';
import type { SkillRegistry } from '../core/skill-registry';
import type { CronService } from '../cron';
import type { Logger } from '../logger';
import type { SessionManager } from '../session';
import { agentsRoutes } from './routes/agents';
import { cronRoutes } from './routes/cron';
import { sessionsRoutes } from './routes/sessions';
import { settingsRoutes } from './routes/settings';
import { skillsRoutes } from './routes/skills';
import { statusRoutes } from './routes/status';
import { toolsRoutes } from './routes/tools';
import { agentLoopRoutes } from './routes/agent-loop';
import { askHumanRoutes } from './routes/ask-human';
import { productionsRoutes } from './routes/productions';

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
  app.route('/api/skills', skillsRoutes({ skillRegistry: deps.skillRegistry }));
  app.route('/api/agents', agentsRoutes({ config, botManager: deps.botManager, configPath: deps.configPath, logger }));
  app.route('/api/sessions', sessionsRoutes({ sessionManager: deps.sessionManager }));
  app.route('/api/cron', cronRoutes({ cronService: deps.cronService }));
  app.route('/api/settings', settingsRoutes({ config, configPath: deps.configPath, logger }));
  app.route('/api/agent-loop', agentLoopRoutes({ config, botManager: deps.botManager, logger }));
  app.route('/api/ask-human', askHumanRoutes({ botManager: deps.botManager, logger }));

  // Productions routes (only if enabled)
  const productionsService = deps.botManager.getProductionsService();
  if (productionsService) {
    app.route('/api/productions', productionsRoutes({ productionsService, botManager: deps.botManager, logger }));
  }

  // Dynamic tools routes (only if enabled)
  const dynamicStore = deps.botManager.getDynamicToolStore();
  const dynamicRegistry = deps.botManager.getDynamicToolRegistry();
  if (dynamicStore && dynamicRegistry) {
    app.route('/api/tools', toolsRoutes({ store: dynamicStore, registry: dynamicRegistry }));
  }

  // Static files from web/ directory
  app.use('/*', serveStatic({ root: './web' }));

  // Fallback: serve index.html for SPA routing
  app.get('*', serveStatic({ root: './web', path: '/index.html' }));

  // --- WebSocket log streaming ---
  const logFile = config.logging?.file || './data/logs/aibot.log';
  const wsClients = new Set<ServerWebSocket<unknown>>();
  let fileOffset = 0;

  function readLastLines(path: string, maxLines: number): string[] {
    try {
      const text = require('fs').readFileSync(path, 'utf-8') as string;
      const lines = text.trimEnd().split('\n');
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }

  function getFileSize(path: string): number {
    try {
      return require('fs').statSync(path).size;
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

  // Initialize offset to current file size
  fileOffset = getFileSize(logFile);

  // Watch log file for changes
  try {
    watch(logFile, () => {
      try {
        const fd = require('fs').openSync(logFile, 'r');
        const stat = require('fs').fstatSync(fd);
        const newSize = stat.size;

        if (newSize <= fileOffset) {
          // File was truncated/rotated — reset
          fileOffset = 0;
        }

        if (newSize > fileOffset) {
          const buf = Buffer.alloc(newSize - fileOffset);
          require('fs').readSync(fd, buf, 0, buf.length, fileOffset);
          fileOffset = newSize;
          require('fs').closeSync(fd);

          const chunk = buf.toString('utf-8');
          const rawLines = chunk.trimEnd().split('\n');
          const parsed: unknown[] = [];
          for (const line of rawLines) {
            if (!line) continue;
            try {
              parsed.push(JSON.parse(line));
            } catch { /* skip malformed */ }
          }
          if (parsed.length > 0) {
            broadcast(JSON.stringify({ type: 'logs', lines: parsed }));
          }
        } else {
          require('fs').closeSync(fd);
        }
      } catch { /* ignore read errors */ }
    });
  } catch {
    logger.warn('Could not watch log file for live streaming');
  }

  Bun.serve({
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/ws/logs') {
        const ok = server.upgrade(req);
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
        wsClients.add(ws);
        // Send last 100 lines as history
        const historyLines = readLastLines(logFile, 100);
        const parsed: unknown[] = [];
        for (const line of historyLines) {
          try {
            parsed.push(JSON.parse(line));
          } catch { /* skip */ }
        }
        ws.send(JSON.stringify({ type: 'history', lines: parsed }));
      },
      message() {
        // No client->server messages needed
      },
      close(ws) {
        wsClients.delete(ws);
      },
    },
  });

  logger.info({ port, host }, `Web UI available at http://${host}:${port}`);
}

import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { BotManager } from '../bot';
import type { Config } from '../config';
import type { SkillRegistry } from '../core/skill-registry';
import type { CronService } from '../cron';
import type { Logger } from '../logger';
import type { SessionManager } from '../session';
import { agentsRoutes } from './routes/agents';
import { cronRoutes } from './routes/cron';
import { sessionsRoutes } from './routes/sessions';
import { skillsRoutes } from './routes/skills';
import { statusRoutes } from './routes/status';

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
  app.route('/api/agents', agentsRoutes({ config, botManager: deps.botManager, configPath: deps.configPath }));
  app.route('/api/sessions', sessionsRoutes({ sessionManager: deps.sessionManager }));
  app.route('/api/cron', cronRoutes({ cronService: deps.cronService }));

  // Static files from web/ directory
  app.use('/*', serveStatic({ root: './web' }));

  // Fallback: serve index.html for SPA routing
  app.get('*', serveStatic({ root: './web', path: '/index.html' }));

  Bun.serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  logger.info({ port, host }, `Web UI available at http://${host}:${port}`);
}

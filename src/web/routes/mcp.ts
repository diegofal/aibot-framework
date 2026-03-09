/**
 * Web routes for MCP management.
 *
 * GET  /api/mcp/servers       — list MCP client connections and their status
 * GET  /api/mcp/expose/status — status of the exposed MCP server
 * POST /api/mcp/expose/start  — start the exposed MCP server
 * POST /api/mcp/expose/stop   — stop the exposed MCP server
 */

import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Logger } from '../../logger';
import type { McpServer } from '../../mcp/server';
import { getTenantId, isAdminOrSingleTenant } from '../../tenant/tenant-scoping';

interface McpRoutesDeps {
  botManager: BotManager;
  logger: Logger;
  getMcpServer: () => McpServer | null;
}

export function mcpRoutes(deps: McpRoutesDeps) {
  const app = new Hono();
  const { botManager, logger, getMcpServer } = deps;

  // Admin-only gate: MCP server management is global, not per-tenant
  app.use('*', async (c, next) => {
    const tenantId = getTenantId(c);
    if (!isAdminOrSingleTenant(tenantId)) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    return next();
  });

  // GET /servers — list MCP client connections
  app.get('/servers', (c) => {
    const pool = botManager.getMcpClientPool();
    return c.json({
      servers: pool.getStatus(),
      connectedCount: pool.connectedCount,
      totalCount: pool.size,
    });
  });

  // GET /expose/status — status of exposed MCP server
  app.get('/expose/status', (c) => {
    const server = getMcpServer();
    return c.json({
      running: server?.running ?? false,
    });
  });

  // POST /expose/start — start exposed MCP server
  app.post('/expose/start', async (c) => {
    const server = getMcpServer();
    if (!server) {
      return c.json({ error: 'MCP expose not configured' }, 400);
    }
    if (server.running) {
      return c.json({ status: 'already_running' });
    }
    try {
      await server.start();
      return c.json({ status: 'started' });
    } catch (err) {
      logger.error({ err }, 'Failed to start MCP exposed server');
      return c.json({ error: 'Failed to start' }, 500);
    }
  });

  // POST /expose/stop — stop exposed MCP server
  app.post('/expose/stop', async (c) => {
    const server = getMcpServer();
    if (!server) {
      return c.json({ error: 'MCP expose not configured' }, 400);
    }
    if (!server.running) {
      return c.json({ status: 'already_stopped' });
    }
    try {
      await server.stop();
      return c.json({ status: 'stopped' });
    } catch (err) {
      logger.error({ err }, 'Failed to stop MCP exposed server');
      return c.json({ error: 'Failed to stop' }, 500);
    }
  });

  return app;
}

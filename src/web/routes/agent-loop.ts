import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';

export function agentLoopRoutes(deps: {
  config: Config;
  botManager: BotManager;
  logger: Logger;
}) {
  const app = new Hono();

  /** Check if botId is accessible to the requesting tenant */
  function checkBotAccess(c: import('hono').Context, botId: string): boolean {
    const bot = deps.config.bots.find((b) => b.id === botId);
    return !bot || isBotAccessible(bot, getTenantId(c));
  }

  // Get agent loop status
  app.get('/', (c) => {
    const state = deps.botManager.getAgentLoopState();
    const tenantId = getTenantId(c);
    const allowedIds = new Set(scopeBots(deps.config.bots ?? [], tenantId).map((b) => b.id));
    return c.json({
      enabled: deps.config.agentLoop.enabled,
      defaultInterval: deps.config.agentLoop.every,
      minInterval: deps.config.agentLoop.minInterval,
      maxInterval: deps.config.agentLoop.maxInterval,
      ...state,
      botSchedules: state.botSchedules.filter((s) => allowedIds.has(s.botId)),
      lastResults: state.lastResults.filter((r) => allowedIds.has(r.botId)),
    });
  });

  // Run agent loop for all bots (admin-only in multi-tenant mode)
  app.post('/run', async (c) => {
    if (getTenantId(c)) {
      return c.json({ error: 'Use per-bot endpoint /run/:botId instead' }, 403);
    }
    deps.logger.info('Agent loop: manual run triggered via API');
    const results = await deps.botManager.runAgentLoopAll();
    return c.json({ ok: true, results });
  });

  // Graceful stop — drain executing cycles then stop (admin-only in multi-tenant mode)
  app.post('/stop-safe', async (c) => {
    if (getTenantId(c)) {
      return c.json({ error: 'Global stop not available for tenants' }, 403);
    }
    deps.logger.info('Agent loop: graceful stop triggered via API');
    try {
      await deps.botManager.gracefulStopAll();
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error({ error: message }, 'Agent loop: graceful stop failed');
      return c.json({ error: message }, 500);
    }
  });

  // LLM diagnostics — per-bot stats (tenant-scoped)
  app.get('/llm-stats', (c) => {
    const tenantId = getTenantId(c);
    const stats = deps.botManager.getLlmStats();
    if (!tenantId || tenantId === '__admin__') {
      return c.json({ stats });
    }
    // Filter stats to only include bots belonging to this tenant
    const allowedBotIds = new Set(
      deps.config.bots.filter((b) => b.tenantId === tenantId).map((b) => b.id)
    );
    const filtered: Record<string, unknown> = {};
    if (stats && typeof stats === 'object') {
      for (const [key, value] of Object.entries(stats as Record<string, unknown>)) {
        if (allowedBotIds.has(key)) filtered[key] = value;
      }
    }
    return c.json({ stats: filtered });
  });

  app.get('/llm-stats/:botId', (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    const stats = deps.botManager.getLlmStats(botId);
    if (!stats) {
      return c.json({ error: 'No stats for this bot' }, 404);
    }
    return c.json({ stats });
  });

  // Run agent loop for a single bot
  app.post('/run/:botId', async (c) => {
    const botId = c.req.param('botId');
    if (!checkBotAccess(c, botId)) return c.json({ error: 'Bot not found' }, 404);
    if (!deps.botManager.isRunning(botId)) {
      return c.json({ error: 'Bot not running' }, 400);
    }
    deps.logger.info({ botId }, 'Agent loop: manual run triggered for bot via API');
    const result = await deps.botManager.runAgentLoop(botId);
    return c.json({ ok: true, result });
  });

  return app;
}

import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import type { Logger } from '../../logger';

export function agentLoopRoutes(deps: {
  config: Config;
  botManager: BotManager;
  logger: Logger;
}) {
  const app = new Hono();

  // Get agent loop status
  app.get('/', (c) => {
    const state = deps.botManager.getAgentLoopState();
    return c.json({
      enabled: deps.config.agentLoop.enabled,
      defaultInterval: deps.config.agentLoop.every,
      minInterval: deps.config.agentLoop.minInterval,
      maxInterval: deps.config.agentLoop.maxInterval,
      ...state,
    });
  });

  // Run agent loop for all bots
  app.post('/run', async (c) => {
    deps.logger.info('Agent loop: manual run triggered via API');
    const results = await deps.botManager.runAgentLoopAll();
    return c.json({ ok: true, results });
  });

  // Graceful stop — drain executing cycles then stop
  app.post('/stop-safe', async (c) => {
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

  // LLM diagnostics — per-bot stats
  app.get('/llm-stats', (c) => {
    const stats = deps.botManager.getLlmStats();
    return c.json({ stats });
  });

  app.get('/llm-stats/:botId', (c) => {
    const botId = c.req.param('botId');
    const stats = deps.botManager.getLlmStats(botId);
    if (!stats) {
      return c.json({ error: 'No stats for this bot' }, 404);
    }
    return c.json({ stats });
  });

  // Run agent loop for a single bot
  app.post('/run/:botId', async (c) => {
    const botId = c.req.param('botId');
    if (!deps.botManager.isRunning(botId)) {
      return c.json({ error: 'Bot not running' }, 400);
    }
    deps.logger.info({ botId }, 'Agent loop: manual run triggered for bot via API');
    const result = await deps.botManager.runAgentLoop(botId);
    return c.json({ ok: true, result });
  });

  return app;
}

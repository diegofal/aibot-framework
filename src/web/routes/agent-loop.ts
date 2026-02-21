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

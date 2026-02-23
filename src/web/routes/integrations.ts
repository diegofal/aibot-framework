import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import type { Logger } from '../../logger';

export function integrationsRoutes(deps: {
  config: Config;
  botManager: BotManager;
  logger: Logger;
}) {
  const app = new Hono();

  // Ollama health check
  app.get('/ollama/status', async (c) => {
    const baseUrl = deps.config.ollama.baseUrl;
    const timeout = deps.config.ollama.timeout;
    const start = Date.now();

    try {
      const response = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return c.json({
          ok: false,
          latencyMs: Date.now() - start,
          models: [],
          baseUrl,
          timeout,
          error: `HTTP ${response.status} ${response.statusText}`,
        });
      }

      const data = await response.json();
      const models: string[] = data.models?.map((m: { name: string }) => m.name) ?? [];

      return c.json({
        ok: true,
        latencyMs: Date.now() - start,
        models,
        baseUrl,
        timeout,
      });
    } catch (err) {
      return c.json({
        ok: false,
        latencyMs: Date.now() - start,
        models: [],
        baseUrl,
        timeout,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Proxy a test chat through OllamaClient
  app.post('/ollama/chat', async (c) => {
    const body = await c.req.json<{ message: string; model?: string }>();

    if (!body.message || typeof body.message !== 'string') {
      return c.json({ error: 'message is required' }, 400);
    }

    const ollamaClient = deps.botManager.getOllamaClient();
    const model = body.model || deps.config.ollama.models.primary;
    const start = Date.now();

    try {
      const response = await ollamaClient.chat(
        [{ role: 'user', content: body.message }],
        { model },
      );

      return c.json({
        response,
        durationMs: Date.now() - start,
        model,
      });
    } catch (err) {
      deps.logger.warn({ err, model }, 'Integrations: Ollama test chat failed');
      return c.json({
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        model,
      }, 500);
    }
  });

  return app;
}

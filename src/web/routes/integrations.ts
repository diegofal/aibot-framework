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

  // List available tool names
  app.get('/ollama/tools', (c) => {
    const toolRegistry = deps.botManager.getToolRegistry();
    const tools = toolRegistry.getDefinitions().map((d) => d.function.name);
    return c.json({ tools });
  });

  // Chat with tools — same code path as the agent loop
  app.post('/ollama/chat-with-tools', async (c) => {
    const body = await c.req.json<{
      message: string;
      model?: string;
      tools?: string[];
    }>();

    if (!body.message || typeof body.message !== 'string') {
      return c.json({ error: 'message is required' }, 400);
    }

    const ollamaClient = deps.botManager.getOllamaClient();
    const toolRegistry = deps.botManager.getToolRegistry();
    const model = body.model || deps.config.ollama.models.primary;
    const allDefs = toolRegistry.getDefinitions();
    const allTools = toolRegistry.getTools();

    // Filter to selected tools (or use all)
    let selectedDefs = allDefs;
    let selectedTools = allTools;
    if (body.tools && body.tools.length > 0) {
      const selected = new Set(body.tools);
      selectedDefs = allDefs.filter((d) => selected.has(d.function.name));
      selectedTools = allTools.filter((t) => selected.has(t.definition.function.name));
    }

    if (selectedDefs.length === 0) {
      return c.json({ error: 'No matching tools found' }, 400);
    }

    // Build a tracking executor
    const toolCalls: Array<{
      name: string;
      args: Record<string, unknown>;
      result: string;
      success: boolean;
    }> = [];
    const toolMap = new Map(selectedTools.map((t) => [t.definition.function.name, t]));

    const executor = async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      const tool = toolMap.get(name);
      if (!tool) {
        const result = { success: false, content: `Unknown tool: ${name}` };
        toolCalls.push({ name, args, result: result.content, success: false });
        return result;
      }
      try {
        const result = await tool.execute(args, deps.logger);
        toolCalls.push({ name, args, result: result.content, success: result.success });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolCalls.push({ name, args, result: msg, success: false });
        return { success: false, content: msg };
      }
    };

    const start = Date.now();

    try {
      const response = await ollamaClient.chat(
        [{ role: 'user', content: body.message }],
        { model, tools: selectedDefs, toolExecutor: executor },
      );

      return c.json({
        response,
        durationMs: Date.now() - start,
        model,
        toolCalls,
      });
    } catch (err) {
      deps.logger.warn({ err, model }, 'Integrations: Ollama chat-with-tools failed');
      return c.json({
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        model,
        toolCalls,
      }, 500);
    }
  });

  // List available ElevenLabs voices (proxied — API key stays server-side)
  app.get('/elevenlabs/voices', async (c) => {
    const ttsConfig = deps.config.media?.tts;
    if (!ttsConfig?.apiKey) {
      return c.json({ error: 'TTS not configured' }, 400);
    }

    const start = Date.now();

    try {
      const response = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': ttsConfig.apiKey },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return c.json({
          error: `ElevenLabs API error (${response.status})`,
          latencyMs: Date.now() - start,
        }, 500);
      }

      const data = await response.json();
      const voices = (data.voices ?? []).map((v: any) => ({
        voice_id: v.voice_id,
        name: v.name,
        labels: v.labels,
        preview_url: v.preview_url,
      }));

      return c.json({ voices, latencyMs: Date.now() - start });
    } catch (err) {
      deps.logger.warn({ err }, 'Integrations: ElevenLabs voices fetch failed');
      return c.json({
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      }, 500);
    }
  });

  return app;
}

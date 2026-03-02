import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { DynamicToolRegistry } from '../../bot/dynamic-tool-registry';
import { TOOL_TO_CATEGORY } from '../../bot/tool-registry';
import type { Logger } from '../../logger';
import { parseMcpToolName } from '../../mcp/tool-adapter';
import type { DynamicToolStore } from '../../tools/dynamic-tool-store';

export function toolsRoutes(deps: {
  store: DynamicToolStore;
  registry: DynamicToolRegistry;
  botManager?: BotManager;
  logger?: Logger;
}) {
  const app = new Hono();

  // List ALL tools (built-in + dynamic) with full parameter schemas
  app.get('/all', (c) => {
    const result: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      source: 'built-in' | 'dynamic' | 'mcp';
      status?: string;
      category?: string;
    }> = [];

    // Registry tools (built-in + MCP) from ToolRegistry
    if (deps.botManager) {
      const toolRegistry = deps.botManager.getToolRegistry();
      const definitions = toolRegistry.getDefinitions();
      for (const def of definitions) {
        const name = def.function.name;
        const cat = TOOL_TO_CATEGORY.get(name);
        if (cat === 'mcp') {
          const parsed = parseMcpToolName(name);
          result.push({
            name,
            description: def.function.description,
            parameters: def.function.parameters,
            source: 'mcp',
            category: parsed?.prefix,
          });
        } else {
          result.push({
            name,
            description: def.function.description,
            parameters: def.function.parameters,
            source: 'built-in',
          });
        }
      }
    }

    // Dynamic tools from DynamicToolStore
    const dynamicTools = deps.store.list();
    // Track registry names to avoid duplicates (approved dynamic tools are also in ToolRegistry)
    const registryNames = new Set(result.map((t) => t.name));

    for (const dt of dynamicTools) {
      if (registryNames.has(dt.name)) {
        // Already listed as built-in (approved dynamic tool) — update source to dynamic
        const existing = result.find((t) => t.name === dt.name);
        if (existing) {
          existing.source = 'dynamic';
          existing.status = dt.status;
        }
        continue;
      }
      result.push({
        name: dt.name,
        description: dt.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(dt.parameters || {}).map(([k, v]) => [
              k,
              {
                type: v.type,
                description: v.description,
              },
            ])
          ),
          required: Object.entries(dt.parameters || {})
            .filter(([, v]) => v.required)
            .map(([k]) => k),
        },
        source: 'dynamic',
        status: dt.status,
      });
    }

    return c.json(result);
  });

  // Execute a tool directly (no LLM)
  app.post('/execute', async (c) => {
    const body = await c.req
      .json<{ name?: string; args?: Record<string, unknown> }>()
      .catch(() => ({}) as { name?: string; args?: Record<string, unknown> });

    if (!body.name) {
      return c.json({ error: 'Missing required field: name' }, 400);
    }

    if (!deps.botManager) {
      return c.json({ error: 'Tool execution not available' }, 500);
    }

    const toolRegistry = deps.botManager.getToolRegistry();
    const tools = toolRegistry.getTools();
    const tool = tools.find((t) => t.definition.function.name === body.name);

    if (!tool) {
      return c.json({ error: `Tool not found: ${body.name}` }, 404);
    }

    const logger =
      deps.logger ??
      ({
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
        child: function () {
          return this as unknown as Logger;
        },
      } as unknown as Logger);

    const start = Date.now();
    try {
      const result = await Promise.race([
        tool.execute(body.args ?? {}, logger),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Tool execution timed out (30s)')), 30_000)
        ),
      ]);
      return c.json({
        success: result.success,
        content: result.content,
        durationMs: Date.now() - start,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({
        success: false,
        content: message,
        durationMs: Date.now() - start,
      });
    }
  });

  // List all dynamic tools
  app.get('/', (c) => {
    const tools = deps.store.list();
    return c.json(tools);
  });

  // Get tool detail + source
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const entry = deps.store.get(id);
    if (!entry) return c.json({ error: 'Tool not found' }, 404);
    return c.json(entry);
  });

  // Approve a tool
  app.post('/:id/approve', (c) => {
    const id = c.req.param('id');
    const meta = deps.registry.approve(id);
    if (!meta) return c.json({ error: 'Tool not found' }, 404);
    return c.json(meta);
  });

  // Reject a tool
  app.post('/:id/reject', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
    const meta = deps.registry.reject(id, body.note);
    if (!meta) return c.json({ error: 'Tool not found' }, 404);
    return c.json(meta);
  });

  // Delete a tool
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.store.delete(id);
    if (!deleted) return c.json({ error: 'Tool not found' }, 404);
    return c.json({ ok: true });
  });

  // Edit tool metadata
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      description?: string;
      scope?: string;
      parameters?: Record<string, { type: string; description: string; required?: boolean }>;
    }>();
    const meta = deps.store.updateMeta(id, body);
    if (!meta) return c.json({ error: 'Tool not found' }, 404);
    return c.json(meta);
  });

  return app;
}

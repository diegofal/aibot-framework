import { Hono } from 'hono';
import type { DynamicToolStore } from '../../tools/dynamic-tool-store';
import type { DynamicToolRegistry } from '../../bot/dynamic-tool-registry';

export function toolsRoutes(deps: {
  store: DynamicToolStore;
  registry: DynamicToolRegistry;
}) {
  const app = new Hono();

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
    const body = await c.req.json<{ note?: string }>().catch(() => ({} as { note?: string }));
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

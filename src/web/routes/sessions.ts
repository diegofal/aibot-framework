import { Hono } from 'hono';
import type { Config } from '../../config';
import type { SessionManager } from '../../session';
import { getTenantId, scopeBots } from '../../tenant/tenant-scoping';

export function sessionsRoutes(deps: { sessionManager: SessionManager; config: Config }) {
  const app = new Hono();

  /** Extract botId from a session key like "bot:mybot:private:123" */
  function extractBotId(key: string): string | undefined {
    const match = key.match(/^bot:([^:]+):/);
    return match?.[1];
  }

  /** Check if a session key belongs to a bot the requesting tenant can access */
  function isSessionAccessible(c: import('hono').Context, key: string): boolean {
    const tenantId = getTenantId(c);
    if (!tenantId || tenantId === '__admin__') return true;
    const botId = extractBotId(key);
    if (!botId) return false;
    const bot = deps.config.bots.find((b) => b.id === botId);
    return !!bot && bot.tenantId === tenantId;
  }

  // List sessions (tenant-scoped)
  app.get('/', (c) => {
    const tenantId = getTenantId(c);
    const allSessions = deps.sessionManager.listSessions();
    if (!tenantId || tenantId === '__admin__') {
      return c.json(allSessions);
    }
    const allowedBotIds = new Set(scopeBots(deps.config.bots, tenantId).map((b) => b.id));
    // biome-ignore lint/suspicious/noExplicitAny: session objects have dynamic shape from SessionManager
    const filtered = allSessions.filter((s: any) => {
      const botId = extractBotId(s.key ?? s.serializedKey ?? '');
      return botId && allowedBotIds.has(botId);
    });
    return c.json(filtered);
  });

  // Get session transcript (paginated)
  app.get('/:key/transcript', (c) => {
    const key = c.req.param('key');
    if (!isSessionAccessible(c, key)) return c.json({ error: 'Session not found' }, 404);

    const limit = Number(c.req.query('limit') ?? '100');
    const offset = Number(c.req.query('offset') ?? '0');

    const meta = deps.sessionManager.getSessionMeta(key);
    if (!meta) return c.json({ error: 'Session not found' }, 404);

    const messages = deps.sessionManager.getFullHistory(key);
    const total = messages.length;
    const page = messages.slice(offset, offset + limit);

    return c.json({ total, offset, limit, messages: page });
  });

  // Clear session
  app.delete('/:key', (c) => {
    const key = c.req.param('key');
    if (!isSessionAccessible(c, key)) return c.json({ error: 'Session not found' }, 404);

    const meta = deps.sessionManager.getSessionMeta(key);
    if (!meta) return c.json({ error: 'Session not found' }, 404);

    deps.sessionManager.clearSession(key);
    deps.sessionManager.flush();

    return c.json({ ok: true });
  });

  return app;
}

import { Hono } from 'hono';
import type { SessionManager } from '../../session';

export function sessionsRoutes(deps: { sessionManager: SessionManager }) {
  const app = new Hono();

  // List all sessions
  app.get('/', (c) => {
    const sessions = deps.sessionManager.listSessions();
    return c.json(sessions);
  });

  // Get session transcript (paginated)
  app.get('/:key/transcript', (c) => {
    const key = c.req.param('key');
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
    const meta = deps.sessionManager.getSessionMeta(key);
    if (!meta) return c.json({ error: 'Session not found' }, 404);

    deps.sessionManager.clearSession(key);
    deps.sessionManager.flush();

    return c.json({ ok: true });
  });

  return app;
}

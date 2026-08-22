/**
 * Chat history REST endpoint — allows widget to load previous messages on reconnect.
 * GET /api/v1/chat/:botId/history?chatId=X&senderId=Y&limit=50
 */
import { Hono } from 'hono';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import type { SessionManager } from '../../session';
import { getTenantId, isBotAccessible } from '../../tenant/tenant-scoping';

export interface ChatHistoryRouteDeps {
  config: Config;
  sessionManager: SessionManager;
  logger: Logger;
}

export function chatHistoryRoutes(deps: ChatHistoryRouteDeps) {
  const { config, sessionManager, logger } = deps;
  // NOTE: nothing currently calls c.set('tenantId', …) — the tenant auth middleware
  // sets 'tenant' (a TenantContext). Declared here so the existing read type-checks;
  // see the tenant-scoping note in the handler below.
  const app = new Hono();

  app.get('/:botId/history', (c) => {
    const botId = c.req.param('botId');
    const chatId = c.req.query('chatId');
    const senderId = c.req.query('senderId');
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') || '50')), 200);

    if (!chatId && !senderId) {
      return c.json({ error: 'Must provide chatId or senderId' }, 400);
    }

    // Verify bot exists
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    // In multi-tenant mode, verify bot belongs to this tenant
    if (config.multiTenant?.enabled && botConfig.tenantId) {
      // See chat.ts: `tenantId` is never set on the context; `tenant` is.
      if (!isBotAccessible(botConfig, getTenantId(c))) {
        return c.json({ error: 'Bot not found' }, 404);
      }
    }

    // Derive session key the same way bot-manager does for channel messages.
    // For widget/REST: chatType=private, userId is derived from senderId.
    // serializeKey for private chats uses "bot:{botId}:private:{userId}"
    const userId = senderId ? Number(senderId) || undefined : undefined;
    const sessionKey = sessionManager.serializeKey({
      botId,
      chatType: 'private',
      chatId: Number(chatId) || 0,
      userId,
    });

    try {
      const history = sessionManager.getHistory(sessionKey, limit);

      // Filter out system messages and context summaries
      const filtered = history.filter((msg) => {
        if (msg.role === 'system') return false;
        if (typeof msg.content === 'string' && msg.content.startsWith('[CONTEXT_SUMMARY]'))
          return false;
        return true;
      });

      return c.json({
        messages: filtered.map((msg) => ({
          role: msg.role === 'assistant' ? 'bot' : msg.role,
          content: msg.content,
        })),
        chatId,
        botId,
        count: filtered.length,
      });
    } catch (err) {
      logger.error({ err, botId, chatId }, 'Failed to fetch chat history');
      return c.json({ error: 'Failed to fetch history' }, 500);
    }
  });

  return app;
}

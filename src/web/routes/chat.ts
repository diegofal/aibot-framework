/**
 * REST Chat API — sync request/response chat endpoint.
 * POST /api/v1/chat/:botId
 */
import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import { restCollectChannel, restToInbound } from '../../channel/rest';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import { verifyUserIdentity } from '../../tenant/identity-verification';
import type { TenantManager } from '../../tenant/manager';

export interface ChatRouteDeps {
  config: Config;
  botManager: BotManager;
  logger: Logger;
  tenantManager: TenantManager | null;
}

export function chatRoutes(deps: ChatRouteDeps) {
  const { config, botManager, logger, tenantManager } = deps;
  const app = new Hono();

  app.post('/:botId', async (c) => {
    const botId = c.req.param('botId');
    const startMs = Date.now();

    // Find bot config
    const botConfig = config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    // Parse body
    let body: {
      message?: string;
      chatId?: string;
      senderId?: string;
      senderName?: string;
      images?: string[];
      userHash?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.message?.trim()) {
      return c.json({ error: 'Missing required field: message' }, 400);
    }

    // Multi-tenant auth: extract tenant from context (set by middleware)
    // In multi-tenant mode, the tenant auth middleware already validates the API key
    // and sets tenant info on the context
    if (config.multiTenant?.enabled && botConfig.tenantId) {
      const tenantId = c.get('tenantId') as string | undefined;
      if (tenantId && botConfig.tenantId !== tenantId) {
        return c.json({ error: 'Bot not found' }, 404);
      }

      // Identity verification
      const identityConfig = botConfig.userIdentityVerification;
      if (identityConfig?.enabled && body.senderId && tenantManager) {
        const tenant = tenantManager.getTenant(botConfig.tenantId);
        if (tenant?.identitySecret) {
          if (!body.userHash) {
            if (identityConfig.required) {
              return c.json({ error: 'Missing userHash for identity verification' }, 403);
            }
            // Not required: proceed without per-user isolation
          } else if (!verifyUserIdentity(tenant.identitySecret, body.senderId, body.userHash)) {
            return c.json({ error: 'Invalid user identity' }, 403);
          }
        }
      }
    }

    // Build inbound message
    const inbound = restToInbound({
      botId,
      message: body.message.trim(),
      chatId: body.chatId,
      senderId: body.senderId,
      senderName: body.senderName,
      images: body.images,
      userHash: body.userHash,
    });

    // Create collect channel
    const { channel, getReply } = restCollectChannel();

    try {
      // Process through the standard pipeline
      const reply = await botManager.handleChannelMessage(inbound, channel, botId);

      const durationMs = Date.now() - startMs;
      logger.info(
        { botId, chatId: inbound.chatId, senderId: body.senderId, durationMs },
        'REST chat request completed'
      );

      return c.json({
        reply: reply || getReply(),
        botId,
        chatId: inbound.chatId,
        durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, botId }, 'REST chat request failed');
      return c.json({ error: 'Failed to process message', detail: message }, 500);
    }
  });

  return app;
}

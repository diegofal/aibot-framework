/**
 * WhatsApp Business API webhook routes.
 *
 * GET  /api/whatsapp/webhook  — Verification handshake (Meta sends this during app setup)
 * POST /api/whatsapp/webhook  — Inbound message webhook
 */
import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import {
  extractMessages,
  extractStatuses,
  verifyWebhookSignature,
  whatsappChannel,
  whatsappToInbound,
} from '../../channel/whatsapp';
import type { WhatsAppConfig, WhatsAppWebhookPayload } from '../../channel/whatsapp';
import type { Config } from '../../config';
import type { Logger } from '../../logger';

export function whatsappWebhookRoutes(deps: {
  config: Config;
  botManager: BotManager;
  logger: Logger;
}) {
  const app = new Hono();
  const { config, botManager, logger } = deps;

  /**
   * Resolve WhatsApp config for a phone number ID.
   * Finds the bot whose whatsapp.phoneNumberId matches.
   */
  function resolveWaConfig(
    phoneNumberId: string
  ): { botId: string; waConfig: WhatsAppConfig } | null {
    for (const bot of config.bots) {
      const wa = bot.whatsapp;
      if (wa?.phoneNumberId === phoneNumberId) {
        return { botId: bot.id, waConfig: wa };
      }
    }
    return null;
  }

  // --- Webhook verification (GET) ---
  app.get('/webhook', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');

    // Find any bot with a matching verifyToken
    const verifyToken = config.bots
      .map((b) => b.whatsapp?.verifyToken)
      .find((t) => t && t === token);

    if (mode === 'subscribe' && verifyToken) {
      logger.info('WhatsApp webhook verified');
      return c.text(challenge ?? '', 200);
    }

    return c.text('Forbidden', 403);
  });

  // --- Inbound message webhook (POST) ---
  app.post('/webhook', async (c) => {
    const rawBody = await c.req.text();

    let payload: WhatsAppWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (payload.object !== 'whatsapp_business_account') {
      return c.text('OK', 200); // Acknowledge but ignore non-WA events
    }

    const extracted = extractMessages(payload);

    for (const { message, contactName, phoneNumberId } of extracted) {
      const resolved = resolveWaConfig(phoneNumberId);
      if (!resolved) {
        logger.warn({ phoneNumberId }, 'No bot configured for WhatsApp phone number ID');
        continue;
      }

      const { botId, waConfig } = resolved;

      // Verify signature if appSecret is configured
      if (waConfig.appSecret) {
        const sig = c.req.header('x-hub-signature-256');
        if (!verifyWebhookSignature(rawBody, sig, waConfig.appSecret)) {
          logger.warn({ botId }, 'WhatsApp webhook signature verification failed');
          continue;
        }
      }

      const inbound = whatsappToInbound(message, contactName, phoneNumberId);
      if (!inbound) continue; // Unsupported message type

      const channel = whatsappChannel(message.from, waConfig);

      try {
        await botManager.handleChannelMessage(inbound, channel, botId);
      } catch (err: unknown) {
        logger.error({ err, botId, from: message.from }, 'WhatsApp message handling failed');
      }
    }

    // --- Process status events (delivered / read / failed) ---
    const statuses = extractStatuses(payload);
    for (const status of statuses) {
      const resolved = resolveWaConfig(status.phoneNumberId);
      if (!resolved) continue;
      logger.info(
        {
          botId: resolved.botId,
          messageId: status.messageId,
          status: status.status,
          recipientId: status.recipientId,
        },
        `WhatsApp status: ${status.status}`
      );
    }

    // Always return 200 to Meta to prevent retries
    return c.text('OK', 200);
  });

  return app;
}

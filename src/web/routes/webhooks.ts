import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Logger } from '../../logger';

export interface WebhookRoutesDeps {
  botManager: BotManager;
  logger: Logger;
}

export function webhookRoutes(deps: WebhookRoutesDeps) {
  const { botManager, logger } = deps;
  const app = new Hono();

  // POST /webhooks/stripe — handle Stripe webhook events
  app.post('/stripe', async (c) => {
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      return c.json({ error: 'Missing stripe-signature header' }, 400);
    }

    try {
      const rawBody = await c.req.text();
      const result = await botManager.handleWebhook(rawBody, signature);

      if (result.success) {
        logger.info({ tenantId: result.tenantId }, 'Stripe webhook processed');
        return c.json({ received: true });
      }

      logger.warn('Stripe webhook processing returned unsuccessful');
      return c.json({ received: true, warning: 'Processing incomplete' });
    } catch (err) {
      logger.error({ err }, 'Stripe webhook error');
      return c.json({ error: 'Webhook processing failed' }, 400);
    }
  });

  return app;
}

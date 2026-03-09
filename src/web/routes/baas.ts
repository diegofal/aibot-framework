import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { CustomizationService } from '../../tenant/customization';
import type { TemplateService } from '../../tenant/template-service';
import type { WebhookEventType, WebhookService } from '../../tenant/webhook-service';

/**
 * BaaS routes: templates, customizations, webhooks.
 * All routes require multi-tenant mode to be active.
 */
export function baasRoutes(botManager: BotManager) {
  const app = new Hono();

  // Guard: multi-tenant must be enabled
  app.use('*', async (c, next) => {
    if (!botManager.isMultiTenant()) {
      return c.json({ error: 'Multi-tenant mode is not enabled' }, 503);
    }
    await next();
  });

  // --- Templates ---

  app.get('/templates', (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getTemplateService()!;
    return c.json(service.list());
  });

  app.get('/templates/:id', (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getTemplateService()!;
    const template = service.get(c.req.param('id'));
    if (!template) return c.json({ error: 'Template not found' }, 404);
    return c.json(template);
  });

  app.post('/templates', async (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getTemplateService()!;
    const body = await c.req.json();
    const { name, description, config, createdBy } = body;
    if (!name || !config) {
      return c.json({ error: 'Missing required fields: name, config' }, 400);
    }
    const template = service.create(name, description ?? '', config, createdBy ?? '__admin__');
    return c.json(template, 201);
  });

  app.put('/templates/:id', async (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getTemplateService()!;
    const body = await c.req.json();
    const updated = service.update(c.req.param('id'), body);
    if (!updated) return c.json({ error: 'Template not found' }, 404);
    return c.json(updated);
  });

  app.delete('/templates/:id', (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getTemplateService()!;
    const deleted = service.delete(c.req.param('id'));
    if (!deleted) return c.json({ error: 'Template not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/templates/:id/instantiate', async (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getTemplateService()!;
    const body = await c.req.json();
    const { tenantId, botId, token, overrides } = body;
    if (!tenantId || !botId || !token) {
      return c.json({ error: 'Missing required fields: tenantId, botId, token' }, 400);
    }
    const botConfig = service.instantiate(c.req.param('id'), tenantId, botId, token, overrides);
    if (!botConfig) return c.json({ error: 'Template not found' }, 404);
    return c.json(botConfig, 201);
  });

  // --- Customizations ---

  app.get('/customizations/:tenantId', (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getCustomizationService()!;
    return c.json(service.getForTenant(c.req.param('tenantId')));
  });

  app.get('/customizations/:tenantId/:botId', (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getCustomizationService()!;
    const custom = service.get(c.req.param('botId'));
    if (!custom || custom.tenantId !== c.req.param('tenantId')) {
      return c.json({ error: 'Customization not found' }, 404);
    }
    return c.json(custom);
  });

  app.put('/customizations/:tenantId/:botId', async (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getCustomizationService()!;
    const body = await c.req.json();
    const result = service.set({
      tenantId: c.req.param('tenantId'),
      botId: c.req.param('botId'),
      ...body,
    });
    return c.json(result);
  });

  app.delete('/customizations/:tenantId/:botId', (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getCustomizationService()!;
    const deleted = service.delete(c.req.param('botId'), c.req.param('tenantId'));
    if (!deleted) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  // --- Webhooks ---

  const VALID_EVENTS: WebhookEventType[] = [
    'message.received',
    'message.sent',
    'bot.started',
    'bot.stopped',
    'bot.error',
    'usage.threshold',
  ];

  app.get('/webhooks/:tenantId', (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getWebhookService()!;
    const hooks = service.listForTenant(c.req.param('tenantId'));
    // Redact secrets in list response
    return c.json(hooks.map(({ secret, ...rest }) => rest));
  });

  app.post('/webhooks/:tenantId', async (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getWebhookService()!;
    const body = await c.req.json();
    const { url, events } = body;
    if (!url || !events?.length) {
      return c.json({ error: 'Missing required fields: url, events' }, 400);
    }
    const invalidEvents = events.filter(
      (e: string) => !VALID_EVENTS.includes(e as WebhookEventType)
    );
    if (invalidEvents.length > 0) {
      return c.json({ error: `Invalid events: ${invalidEvents.join(', ')}` }, 400);
    }
    const reg = service.register(c.req.param('tenantId'), url, events);
    return c.json(reg, 201);
  });

  app.put('/webhooks/:tenantId/:id', async (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getWebhookService()!;
    const body = await c.req.json();
    const updated = service.update(c.req.param('id'), c.req.param('tenantId'), body);
    if (!updated) return c.json({ error: 'Webhook not found' }, 404);
    return c.json(updated);
  });

  app.delete('/webhooks/:tenantId/:id', (c) => {
    // biome-ignore lint/style/noNonNullAssertion: service guaranteed by middleware
    const service = botManager.getWebhookService()!;
    const deleted = service.delete(c.req.param('id'), c.req.param('tenantId'));
    if (!deleted) return c.json({ error: 'Webhook not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}

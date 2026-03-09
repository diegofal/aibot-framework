/**
 * Analytics API routes — conversation metrics per tenant/bot.
 *
 * GET /api/baas/analytics/:tenantId              — Tenant-wide metrics
 * GET /api/baas/analytics/:tenantId/:botId       — Per-bot metrics
 * GET /api/baas/analytics/:tenantId/current-month — Current month summary
 */
import { Hono } from 'hono';
import type { AnalyticsService } from '../../tenant/analytics-service';

export function analyticsRoutes(analyticsService: AnalyticsService) {
  const app = new Hono();

  // GET /analytics/:tenantId — Tenant-wide metrics for a date range
  app.get('/:tenantId', (c) => {
    const tenantId = c.req.param('tenantId');
    const startDate = c.req.query('start');
    const endDate = c.req.query('end');

    if (!startDate || !endDate) {
      return c.json({ error: 'Missing required query params: start, end (ISO date strings)' }, 400);
    }

    const metrics = analyticsService.getMetrics(tenantId, startDate, endDate);
    return c.json(metrics);
  });

  // GET /analytics/:tenantId/current-month — Current month summary
  app.get('/:tenantId/current-month', (c) => {
    const tenantId = c.req.param('tenantId');
    const metrics = analyticsService.getCurrentMonthMetrics(tenantId);
    return c.json(metrics);
  });

  // GET /analytics/:tenantId/:botId — Per-bot metrics for a date range
  app.get('/:tenantId/:botId', (c) => {
    const tenantId = c.req.param('tenantId');
    const botId = c.req.param('botId');
    const startDate = c.req.query('start');
    const endDate = c.req.query('end');

    if (!startDate || !endDate) {
      return c.json({ error: 'Missing required query params: start, end (ISO date strings)' }, 400);
    }

    const metrics = analyticsService.getBotMetrics(tenantId, botId, startDate, endDate);
    return c.json(metrics);
  });

  return app;
}

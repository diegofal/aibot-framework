/**
 * Claude accounts (prototype): list, log in from the dashboard, switch the
 * account the whole fleet uses. Admin only: an account is fleet-wide and its
 * login writes credentials into the data volume.
 */
import { Hono } from 'hono';
import type { ClaudeAccountService } from '../../claude-accounts/service';
import type { Logger } from '../../logger';
import { getTenantId, isAdminOrSingleTenant } from '../../tenant/tenant-scoping';

export function claudeAccountsRoutes(deps: { accounts: ClaudeAccountService; logger: Logger }) {
  const app = new Hono();
  const { accounts, logger } = deps;

  app.use('*', async (c, next) => {
    if (!isAdminOrSingleTenant(getTenantId(c))) return c.json({ error: 'Admin only' }, 403);
    await next();
  });

  const fail = (err: unknown) => (err instanceof Error ? err.message : String(err));

  app.get('/', async (c) => c.json({ accounts: await accounts.list() }));

  app.post('/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; slug?: unknown };
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const slug = typeof body.slug === 'string' && body.slug ? body.slug : undefined;
    if (!label && !slug) return c.json({ error: 'A name for the account is required' }, 400);
    try {
      return c.json(await accounts.startLogin(label, slug ? { slug } : {}));
    } catch (err) {
      logger.warn({ err: fail(err) }, 'Claude accounts: login could not start');
      return c.json({ error: fail(err) }, 502);
    }
  });

  app.post('/login/:id/code', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) return c.json({ error: 'Paste the code from the sign-in page' }, 400);
    const result = await accounts.submitCode(c.req.param('id'), code);
    logger.info({ ok: result.ok, slug: result.slug }, 'Claude accounts: login finished');
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post('/login/:id/cancel', (c) => {
    accounts.cancel(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/:slug/activate', async (c) => {
    try {
      await accounts.activate(c.req.param('slug'));
      logger.info({ slug: c.req.param('slug') }, 'Claude accounts: active account switched');
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: fail(err) }, 400);
    }
  });

  app.patch('/:slug', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown };
    try {
      await accounts.rename(c.req.param('slug'), typeof body.label === 'string' ? body.label : '');
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: fail(err) }, 400);
    }
  });

  app.post('/:slug/test', async (c) => {
    try {
      return c.json(await accounts.test(c.req.param('slug')));
    } catch (err) {
      return c.json({ ok: false, error: fail(err) }, 400);
    }
  });

  app.delete('/:slug', async (c) => {
    try {
      await accounts.remove(c.req.param('slug'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: fail(err) }, 400);
    }
  });

  return app;
}

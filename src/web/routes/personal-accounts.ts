/**
 * Personal accounts (docs/plans/personal-organizer-plan.md, P1a): the
 * operator's Google and Microsoft accounts. Admin only, like Claude accounts:
 * the accounts are the operator's own and their tokens live in the data
 * volume. The one exception is `GET /callback/:provider`, where the
 * provider's redirect lands without the dashboard's Bearer token: it is
 * public (see src/web/public-api-paths.ts) and only accepts a known,
 * unexpired, single-use state issued by `POST /login`.
 */
import { Hono } from 'hono';
import type { Logger } from '../../logger';
import { isPersonalProvider } from '../../personal-accounts/service';
import type { PersonalAccountService } from '../../personal-accounts/service';
import { getTenantId, isAdminOrSingleTenant } from '../../tenant/tenant-scoping';

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The small page the browser lands on after consent. */
export function callbackPage(ok: boolean, message: string): string {
  const title = ok ? 'Account connected' : 'Account not connected';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}
h1{font-size:1.3rem}.err{color:#a33}</style></head><body>
<h1 class="${ok ? '' : 'err'}">${title}</h1><p>${esc(message)}</p>
<p><a href="/#/settings/integrations">Back to Integrations</a> · you can close this tab.</p>
</body></html>`;
}

export function personalAccountsRoutes(deps: {
  accounts: PersonalAccountService;
  logger: Logger;
}) {
  const app = new Hono();
  const { accounts, logger } = deps;
  const fail = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // Public on purpose: the state is the credential.
  app.get('/callback/:provider', async (c) => {
    const provider = c.req.param('provider');
    if (!isPersonalProvider(provider)) return c.html(callbackPage(false, 'Unknown provider.'), 404);
    const state = c.req.query('state') ?? '';
    const providerError = c.req.query('error');
    if (providerError) {
      accounts.discardLogin(provider, state);
      const detail = c.req.query('error_description');
      logger.info({ provider, error: providerError }, 'Personal accounts: consent not given');
      return c.html(
        callbackPage(false, `The provider said: ${providerError}${detail ? ` (${detail})` : ''}`),
        400
      );
    }
    const result = await accounts.completeLogin(provider, c.req.query('code') ?? '', state);
    if (!result.ok) {
      logger.warn({ provider, error: result.error }, 'Personal accounts: login failed');
      return c.html(callbackPage(false, result.error), 400);
    }
    logger.info({ provider, slug: result.slug }, 'Personal accounts: account connected');
    return c.html(callbackPage(true, `${result.email} is connected as "${result.slug}".`));
  });

  app.use('*', async (c, next) => {
    if (!isAdminOrSingleTenant(getTenantId(c))) return c.json({ error: 'Admin only' }, 403);
    await next();
  });

  app.get('/', (c) => c.json({ accounts: accounts.list(), providers: accounts.providers() }));

  app.post('/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { provider?: unknown; label?: unknown };
    if (!isPersonalProvider(body.provider))
      return c.json({ error: 'provider must be "google" or "microsoft"' }, 400);
    const label = typeof body.label === 'string' ? body.label : '';
    try {
      return c.json({ url: accounts.startLogin(body.provider, label).url });
    } catch (err) {
      return c.json({ error: fail(err) }, 400);
    }
  });

  app.patch('/:slug', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown };
    try {
      accounts.setLabel(c.req.param('slug'), typeof body.label === 'string' ? body.label : '');
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: fail(err) }, /^Unknown account/.test(fail(err)) ? 404 : 400);
    }
  });

  app.delete('/:slug', (c) => {
    try {
      accounts.remove(c.req.param('slug'));
      logger.info({ slug: c.req.param('slug') }, 'Personal accounts: account removed');
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: fail(err) }, 404);
    }
  });

  return app;
}

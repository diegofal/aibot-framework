import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { chatRoutes } from '../../../src/web/routes/chat';
import { chatHistoryRoutes } from '../../../src/web/routes/chat-history';

// Both routes used to read `c.get('tenantId')`, which nothing ever sets — the
// tenant middleware sets `tenant`, a TenantContext. The cross-tenant guard was
// therefore unreachable and failed OPEN: an authenticated tenant could chat
// with, and read the history of, another tenant's bot.

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const config = {
  multiTenant: { enabled: true },
  bots: [
    { id: 'acme-bot', name: 'Acme Bot', tenantId: 'acme' },
    { id: 'globex-bot', name: 'Globex Bot', tenantId: 'globex' },
  ],
} as unknown as Config;

const botManager = {
  isRunning: () => true,
  handleRestMessage: async () => 'hi',
  handleChannelMessage: async () => 'hi',
} as never;

const sessionManager = {
  serializeKey: () => 'k',
  getSession: () => undefined,
  getMessages: () => [],
} as never;

/** Mounts both routes behind a middleware that sets `tenant` like the real one. */
function makeApp(tenantId: string | undefined) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (tenantId) c.set('tenant', { tenantId } as never);
    await next();
  });
  app.route('/api/chat', chatRoutes({ config, botManager, logger: noopLogger }));
  app.route('/api/chat', chatHistoryRoutes({ config, sessionManager, logger: noopLogger }));
  return app;
}

const post = (app: Hono, bot: string) =>
  app.request(`/api/chat/${bot}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  });

describe('chat routes: cross-tenant isolation', () => {
  test('a tenant cannot POST to another tenant’s bot', async () => {
    const res = await post(makeApp('acme'), 'globex-bot');
    expect(res.status).toBe(404);
  });

  test('a tenant can POST to its own bot', async () => {
    const res = await post(makeApp('acme'), 'acme-bot');
    expect(res.status).not.toBe(404);
  });

  test('admin reaches any bot', async () => {
    const res = await post(makeApp('__admin__'), 'globex-bot');
    expect(res.status).not.toBe(404);
  });
});

describe('chat history: cross-tenant isolation', () => {
  test('a tenant cannot read another tenant’s bot history', async () => {
    const res = await makeApp('acme').request('/api/chat/globex-bot/history?chatId=1');
    expect(res.status).toBe(404);
  });

  test('a tenant can read its own bot history', async () => {
    const res = await makeApp('acme').request('/api/chat/acme-bot/history?chatId=1');
    expect(res.status).not.toBe(404);
  });

  test('admin reads any bot history', async () => {
    const res = await makeApp('__admin__').request('/api/chat/globex-bot/history?chatId=1');
    expect(res.status).not.toBe(404);
  });
});

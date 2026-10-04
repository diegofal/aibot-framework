import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { productionsRoutes } from '../../../src/web/routes/productions';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as unknown as Logger;

function makeApp() {
  const archived: Array<[string, string, string]> = [];
  const productionsService = {
    getEntry: (_botId: string, id: string) => (id === 'p1' ? { id, path: 'out/a.md' } : null),
    archiveFile: (botId: string, path: string, reason: string) => {
      archived.push([botId, path, reason]);
      return true;
    },
  };
  const app = new Hono();
  app.route(
    '/api/productions',
    productionsRoutes({
      productionsService: productionsService as never,
      botManager: {} as never,
      logger: noopLogger,
      config: { bots: [{ id: 'bot1', name: 'B' }] } as unknown as Config,
    })
  );
  return { app, archived };
}

describe('POST /api/productions/:botId/:id/archive', () => {
  test('accepts a request without a body and uses the default reason', async () => {
    const { app, archived } = makeApp();
    const res = await app.request('/api/productions/bot1/p1/archive', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(archived).toEqual([['bot1', 'out/a.md', 'Archived from dashboard']]);
  });

  test('keeps an explicit reason', async () => {
    const { app, archived } = makeApp();
    await app.request('/api/productions/bot1/p1/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Archived from Needs You' }),
    });
    expect(archived[0][2]).toBe('Archived from Needs You');
  });

  test('404s an unknown production', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/productions/bot1/nope/archive', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

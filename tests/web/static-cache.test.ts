import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { dashboardNoCache } from '../../src/web/static-cache';

function appServing(path: string, contentType: string, body = 'x') {
  const app = new Hono();
  app.use('/*', dashboardNoCache);
  app.get(path, (c) => c.body(body, 200, { 'Content-Type': contentType }));
  return app;
}

describe('dashboardNoCache', () => {
  test('forces revalidation of the stylesheet', async () => {
    const res = await appServing('/style.css', 'text/css').request('/style.css');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  test('forces revalidation of ES modules', async () => {
    const res = await appServing('/app.js', 'text/javascript;charset=utf-8').request('/app.js');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  test('forces revalidation of the SPA shell', async () => {
    const res = await appServing('/', 'text/html;charset=utf-8').request('/');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  test('leaves API responses alone', async () => {
    const app = new Hono();
    app.use('/*', dashboardNoCache);
    app.get('/api/agents', (c) => c.json({ ok: true }));
    const res = await app.request('/api/agents');
    expect(res.headers.get('Cache-Control')).toBeNull();
  });

  test('leaves images and other assets cacheable', async () => {
    const res = await appServing('/logo.png', 'image/png').request('/logo.png');
    expect(res.headers.get('Cache-Control')).toBeNull();
  });

  test('does not overwrite an explicit Cache-Control set upstream', async () => {
    const app = new Hono();
    app.use('/*', dashboardNoCache);
    app.get('/vendor.js', (c) =>
      c.body('x', 200, {
        'Content-Type': 'text/javascript',
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
    );
    const res = await app.request('/vendor.js');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });
});

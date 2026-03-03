import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getTenantId, isBotAccessible, scopeBots } from '../src/tenant/tenant-scoping';

describe('Tenant Scoping Helpers', () => {
  const bots = [
    { id: 'bot-a', name: 'Bot A', tenantId: 'tenant-1', token: '', enabled: true, skills: [] },
    { id: 'bot-b', name: 'Bot B', tenantId: 'tenant-1', token: '', enabled: true, skills: [] },
    { id: 'bot-c', name: 'Bot C', tenantId: 'tenant-2', token: '', enabled: true, skills: [] },
    { id: 'bot-d', name: 'Bot D', token: '', enabled: true, skills: [] }, // no tenantId
  ] as any[];

  describe('scopeBots', () => {
    test('returns all bots when tenantId is undefined', () => {
      const result = scopeBots(bots, undefined);
      expect(result).toHaveLength(4);
    });

    test('returns only tenant bots when tenantId is set', () => {
      const result = scopeBots(bots, 'tenant-1');
      expect(result).toHaveLength(2);
      expect(result.map((b: any) => b.id)).toEqual(['bot-a', 'bot-b']);
    });

    test('returns empty for unknown tenant', () => {
      const result = scopeBots(bots, 'tenant-99');
      expect(result).toHaveLength(0);
    });

    test('returns all bots when tenantId is __admin__', () => {
      const result = scopeBots(bots, '__admin__');
      expect(result).toHaveLength(4);
      expect(result.map((b: any) => b.id)).toEqual(['bot-a', 'bot-b', 'bot-c', 'bot-d']);
    });
  });

  describe('isBotAccessible', () => {
    test('returns true when tenantId is undefined (single-tenant)', () => {
      expect(isBotAccessible(bots[0], undefined)).toBe(true);
      expect(isBotAccessible(bots[2], undefined)).toBe(true);
    });

    test('returns true when bot belongs to tenant', () => {
      expect(isBotAccessible(bots[0], 'tenant-1')).toBe(true);
      expect(isBotAccessible(bots[1], 'tenant-1')).toBe(true);
    });

    test('returns false when bot belongs to different tenant', () => {
      expect(isBotAccessible(bots[0], 'tenant-2')).toBe(false);
      expect(isBotAccessible(bots[2], 'tenant-1')).toBe(false);
    });

    test('returns false for bot without tenantId when tenant is specified', () => {
      expect(isBotAccessible(bots[3], 'tenant-1')).toBe(false);
    });

    test('returns true for any bot when tenantId is __admin__', () => {
      expect(isBotAccessible(bots[0], '__admin__')).toBe(true);
      expect(isBotAccessible(bots[2], '__admin__')).toBe(true);
      expect(isBotAccessible(bots[3], '__admin__')).toBe(true); // bot without tenantId
    });
  });

  describe('getTenantId', () => {
    test('returns undefined when tenant context is not set', async () => {
      const app = new Hono();
      app.get('/test', (c) => {
        const tenantId = getTenantId(c);
        return c.json({ tenantId: tenantId ?? null });
      });

      const res = await app.request('/test');
      const body = await res.json();
      expect(body.tenantId).toBeNull();
    });

    test('returns tenantId when set in context', async () => {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('tenant', { tenantId: 'tenant-1', apiKey: 'key', plan: 'starter' });
        await next();
      });
      app.get('/test', (c) => {
        const tenantId = getTenantId(c);
        return c.json({ tenantId });
      });

      const res = await app.request('/test');
      const body = await res.json();
      expect(body.tenantId).toBe('tenant-1');
    });
  });
});

describe('Tenant Route Scoping Integration', () => {
  test('agents list returns only tenant bots when tenant context is set', async () => {
    // Simulate route handler pattern
    const app = new Hono();
    const bots = [
      { id: 'bot-a', name: 'Bot A', tenantId: 'tenant-1', token: 'tok-a' },
      { id: 'bot-b', name: 'Bot B', tenantId: 'tenant-2', token: 'tok-b' },
      { id: 'bot-c', name: 'Bot C', tenantId: 'tenant-1', token: 'tok-c' },
    ] as any[];

    // Tenant middleware sets context
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: 'tenant-1', apiKey: 'key', plan: 'starter' });
      await next();
    });

    app.get('/agents', (c) => {
      const tenantId = getTenantId(c);
      const scoped = scopeBots(bots, tenantId);
      return c.json(scoped.map((b: any) => ({ id: b.id, name: b.name })));
    });

    app.get('/agents/:id', (c) => {
      const id = c.req.param('id');
      const bot = bots.find((b: any) => b.id === id);
      if (!bot || !isBotAccessible(bot, getTenantId(c))) {
        return c.json({ error: 'Agent not found' }, 404);
      }
      return c.json({ id: bot.id, name: bot.name });
    });

    // List - should only show tenant-1 bots
    const listRes = await app.request('/agents');
    const listBody = await listRes.json();
    expect(listBody).toHaveLength(2);
    expect(listBody.map((b: any) => b.id)).toEqual(['bot-a', 'bot-c']);

    // Get own bot - should succeed
    const getOwnRes = await app.request('/agents/bot-a');
    expect(getOwnRes.status).toBe(200);

    // Get other tenant's bot - should 404
    const getOtherRes = await app.request('/agents/bot-b');
    expect(getOtherRes.status).toBe(404);
  });

  test('without tenant context, all bots are visible', async () => {
    const app = new Hono();
    const bots = [
      { id: 'bot-a', name: 'Bot A', tenantId: 'tenant-1' },
      { id: 'bot-b', name: 'Bot B', tenantId: 'tenant-2' },
    ] as any[];

    // No tenant middleware - single-tenant mode
    app.get('/agents', (c) => {
      const tenantId = getTenantId(c);
      const scoped = scopeBots(bots, tenantId);
      return c.json(scoped.map((b: any) => ({ id: b.id })));
    });

    const res = await app.request('/agents');
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  test('tenant cannot modify bots from another tenant', async () => {
    const app = new Hono();
    const bots = [
      { id: 'bot-a', name: 'Bot A', tenantId: 'tenant-1' },
      { id: 'bot-b', name: 'Bot B', tenantId: 'tenant-2' },
    ] as any[];

    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: 'tenant-1', apiKey: 'key', plan: 'starter' });
      await next();
    });

    app.delete('/agents/:id', (c) => {
      const id = c.req.param('id');
      const bot = bots.find((b: any) => b.id === id);
      if (!bot || !isBotAccessible(bot, getTenantId(c))) {
        return c.json({ error: 'Agent not found' }, 404);
      }
      return c.json({ ok: true });
    });

    // Delete own bot - should succeed
    const deleteOwnRes = await app.request('/agents/bot-a', { method: 'DELETE' });
    expect(deleteOwnRes.status).toBe(200);

    // Delete other tenant's bot - should 404
    const deleteOtherRes = await app.request('/agents/bot-b', { method: 'DELETE' });
    expect(deleteOtherRes.status).toBe(404);
  });

  test('admin (__admin__) sees all bots including those without tenantId', async () => {
    const app = new Hono();
    const bots = [
      { id: 'bot-a', name: 'Bot A', tenantId: 'tenant-1', token: 'tok-a' },
      { id: 'bot-b', name: 'Bot B', tenantId: 'tenant-2', token: 'tok-b' },
      { id: 'bot-legacy', name: 'Legacy Bot', token: 'tok-c' }, // no tenantId
    ] as any[];

    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: '__admin__', apiKey: 'admin-key', plan: 'enterprise' });
      await next();
    });

    app.get('/agents', (c) => {
      const tenantId = getTenantId(c);
      const scoped = scopeBots(bots, tenantId);
      return c.json(scoped.map((b: any) => ({ id: b.id, name: b.name })));
    });

    app.get('/agents/:id', (c) => {
      const id = c.req.param('id');
      const bot = bots.find((b: any) => b.id === id);
      if (!bot || !isBotAccessible(bot, getTenantId(c))) {
        return c.json({ error: 'Agent not found' }, 404);
      }
      return c.json({ id: bot.id, name: bot.name });
    });

    const listRes = await app.request('/agents');
    const listBody = await listRes.json();
    expect(listBody).toHaveLength(3);
    expect(listBody.map((b: any) => b.id)).toEqual(['bot-a', 'bot-b', 'bot-legacy']);

    const getLegacyRes = await app.request('/agents/bot-legacy');
    expect(getLegacyRes.status).toBe(200);
    const legacyBody = await getLegacyRes.json();
    expect(legacyBody.id).toBe('bot-legacy');
  });

  test('new bots get tenant ID assigned', async () => {
    const app = new Hono();
    const bots: any[] = [];

    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: 'tenant-1', apiKey: 'key', plan: 'starter' });
      await next();
    });

    app.post('/agents', async (c) => {
      const tenantId = getTenantId(c);
      const body = await c.req.json();
      const newBot = { ...body, ...(tenantId ? { tenantId } : {}) };
      bots.push(newBot);
      return c.json(newBot, 201);
    });

    const res = await app.request('/agents', {
      method: 'POST',
      body: JSON.stringify({ id: 'new-bot', name: 'New Bot' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tenantId).toBe('tenant-1');
    expect(bots[0].tenantId).toBe('tenant-1');
  });
});

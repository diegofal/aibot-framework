import { beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createAuthRateLimitMiddleware } from '../src/tenant/auth-rate-limiter';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

describe('Auth rate limiter middleware', () => {
  describe('IP-based limiting', () => {
    it('allows requests under the IP limit', async () => {
      const { middleware } = createAuthRateLimitMiddleware(noopLogger, {
        maxPerIp: 3,
        maxPerEmail: 10,
        windowMs: 60_000,
      });

      const app = new Hono();
      app.use('*', middleware);
      app.post('/login', (c) => c.json({ ok: true }));

      const makeReq = () =>
        app.request('/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': '1.2.3.4',
          },
          body: JSON.stringify({ email: 'test@example.com', password: 'whatever' }),
        });

      // First 3 should pass
      for (let i = 0; i < 3; i++) {
        const res = await makeReq();
        expect(res.status).toBe(200);
      }

      // 4th should be blocked
      const blocked = await makeReq();
      expect(blocked.status).toBe(429);
      const body = (await blocked.json()) as any;
      expect(body.error).toBe('Too Many Requests');
      expect(body.retryAfterSec).toBeGreaterThan(0);
      expect(blocked.headers.get('Retry-After')).toBeTruthy();
    });

    it('isolates different IPs', async () => {
      const { middleware } = createAuthRateLimitMiddleware(noopLogger, {
        maxPerIp: 2,
        maxPerEmail: 100,
        windowMs: 60_000,
      });

      const app = new Hono();
      app.use('*', middleware);
      app.post('/login', (c) => c.json({ ok: true }));

      // Exhaust IP 1.1.1.1
      for (let i = 0; i < 2; i++) {
        await app.request('/login', {
          method: 'POST',
          headers: { 'X-Forwarded-For': '1.1.1.1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: `user${i}@test.com`, password: 'x' }),
        });
      }

      // IP 2.2.2.2 should still work
      const res = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '2.2.2.2', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@test.com', password: 'x' }),
      });
      expect(res.status).toBe(200);
    });

    it('falls back to "unknown" when no IP headers present', async () => {
      const { middleware } = createAuthRateLimitMiddleware(noopLogger, {
        maxPerIp: 1,
        maxPerEmail: 100,
        windowMs: 60_000,
      });

      const app = new Hono();
      app.use('*', middleware);
      app.post('/login', (c) => c.json({ ok: true }));

      // First passes
      const res1 = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', password: 'x' }),
      });
      expect(res1.status).toBe(200);

      // Second blocked (same "unknown" IP)
      const res2 = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', password: 'x' }),
      });
      expect(res2.status).toBe(429);
    });
  });

  describe('Email-based limiting', () => {
    it('blocks after too many attempts against same email', async () => {
      const { middleware } = createAuthRateLimitMiddleware(noopLogger, {
        maxPerIp: 100, // high IP limit so we only test email
        maxPerEmail: 2,
        windowMs: 60_000,
      });

      const app = new Hono();
      app.use('*', middleware);
      app.post('/login', (c) => c.json({ ok: true }));

      const target = 'victim@example.com';

      // 2 attempts from different IPs — both should pass
      for (let i = 0; i < 2; i++) {
        const res = await app.request('/login', {
          method: 'POST',
          headers: {
            'X-Forwarded-For': `10.0.0.${i + 1}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email: target, password: 'wrong' }),
        });
        expect(res.status).toBe(200);
      }

      // 3rd attempt against same email from yet another IP — blocked
      const blocked = await app.request('/login', {
        method: 'POST',
        headers: {
          'X-Forwarded-For': '10.0.0.99',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: target, password: 'wrong' }),
      });
      expect(blocked.status).toBe(429);
      const body = (await blocked.json()) as any;
      expect(body.message).toContain('this account');
    });

    it('normalizes email to lowercase', async () => {
      const { middleware } = createAuthRateLimitMiddleware(noopLogger, {
        maxPerIp: 100,
        maxPerEmail: 1,
        windowMs: 60_000,
      });

      const app = new Hono();
      app.use('*', middleware);
      app.post('/login', (c) => c.json({ ok: true }));

      // First attempt with mixed case
      const res1 = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '1.1.1.1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'Alice@Example.COM', password: 'x' }),
      });
      expect(res1.status).toBe(200);

      // Second with lowercase — should count as same email
      const res2 = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '2.2.2.2', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', password: 'x' }),
      });
      expect(res2.status).toBe(429);
    });
  });

  describe('Body parsing edge cases', () => {
    it('still applies IP limiting when body is not JSON', async () => {
      const { middleware } = createAuthRateLimitMiddleware(noopLogger, {
        maxPerIp: 1,
        maxPerEmail: 100,
        windowMs: 60_000,
      });

      const app = new Hono();
      app.use('*', middleware);
      app.post('/login', (c) => c.json({ ok: true }));

      const res1 = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '5.5.5.5' },
        body: 'not json',
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '5.5.5.5' },
        body: 'not json',
      });
      expect(res2.status).toBe(429);
    });

    it('still applies IP limiting when email is missing from body', async () => {
      const { middleware } = createAuthRateLimitMiddleware(noopLogger, {
        maxPerIp: 1,
        maxPerEmail: 100,
        windowMs: 60_000,
      });

      const app = new Hono();
      app.use('*', middleware);
      app.post('/login', (c) => c.json({ ok: true }));

      const res1 = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '6.6.6.6', 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'no-email' }),
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '6.6.6.6', 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'no-email' }),
      });
      expect(res2.status).toBe(429);
    });
  });

  describe('Sliding window expiry', () => {
    it('allows requests again after window expires', async () => {
      const { middleware } = createAuthRateLimitMiddleware(noopLogger, {
        maxPerIp: 1,
        maxPerEmail: 100,
        windowMs: 50, // 50ms window for test speed
      });

      const app = new Hono();
      app.use('*', middleware);
      app.post('/login', (c) => c.json({ ok: true }));

      const res1 = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '7.7.7.7', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', password: 'x' }),
      });
      expect(res1.status).toBe(200);

      // Blocked immediately
      const res2 = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '7.7.7.7', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', password: 'x' }),
      });
      expect(res2.status).toBe(429);

      // Wait for window to expire
      await new Promise((r) => setTimeout(r, 70));

      // Should be allowed again
      const res3 = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '7.7.7.7', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', password: 'x' }),
      });
      expect(res3.status).toBe(200);
    });
  });

  describe('Cleanup', () => {
    it('exposes limiter for periodic cleanup', () => {
      const { limiter } = createAuthRateLimitMiddleware(noopLogger);
      expect(limiter).toBeDefined();
      expect(typeof limiter.cleanup).toBe('function');
      // Should not throw
      limiter.cleanup();
    });
  });

  describe('Response headers', () => {
    it('sets X-RateLimit-Remaining header on allowed requests', async () => {
      const { middleware } = createAuthRateLimitMiddleware(noopLogger, {
        maxPerIp: 5,
        maxPerEmail: 100,
        windowMs: 60_000,
      });

      const app = new Hono();
      app.use('*', middleware);
      app.post('/login', (c) => c.json({ ok: true }));

      const res = await app.request('/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '8.8.8.8', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x@y.com', password: 'z' }),
      });
      expect(res.status).toBe(200);
      const remaining = res.headers.get('X-RateLimit-Remaining');
      expect(remaining).toBeTruthy();
      expect(Number(remaining)).toBeLessThanOrEqual(4);
    });
  });
});

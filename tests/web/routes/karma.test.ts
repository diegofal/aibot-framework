import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import { KarmaService } from '../../../src/karma/service';
import type { Logger } from '../../../src/logger';
import { karmaRoutes } from '../../../src/web/routes/karma';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(process.cwd(), '.test-karma-routes');

const mockConfig = {
  bots: [
    { id: 'bot1', name: 'TestBot1' },
    { id: 'bot2', name: 'TestBot2' },
  ],
} as unknown as Config;

function makeApp(karmaService: KarmaService) {
  const app = new Hono();
  app.route(
    '/api/karma',
    karmaRoutes({
      karmaService,
      config: mockConfig,
      logger: noopLogger,
    })
  );
  return app;
}

describe('karma routes', () => {
  let service: KarmaService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new KarmaService(
      {
        enabled: true,
        baseDir: TEST_DIR,
        initialScore: 50,
        decayDays: 30,
      },
      noopLogger
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('GET /', () => {
    test('returns scores for all configured bots', async () => {
      service.addEvent('bot1', 10, 'Good work', 'production');

      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.length).toBe(2);
      expect(data[0].botId).toBe('bot1');
      expect(data[0].current).toBe(60);
      expect(data[1].botId).toBe('bot2');
      expect(data[1].current).toBe(50);
    });

    test('returns initial scores when no events exist', async () => {
      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma');
      const data = await res.json();

      expect(data.every((s: any) => s.current === 50)).toBe(true);
      expect(data.every((s: any) => s.trend === 'stable')).toBe(true);
    });
  });

  describe('GET /:botId', () => {
    test('returns score for a specific bot', async () => {
      service.addEvent('bot1', 5, 'Good', 'production');

      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/bot1');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.botId).toBe('bot1');
      expect(data.current).toBe(55);
      expect(data.trend).toBe('rising');
      expect(data.recentEvents.length).toBe(1);
    });

    test('returns 404 for unknown bot', async () => {
      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/unknown');
      expect(res.status).toBe(404);

      const data = await res.json();
      expect(data.error).toBe('Bot not found');
    });
  });

  describe('GET /:botId/history', () => {
    test('returns paginated history', async () => {
      for (let i = 0; i < 10; i++) {
        service.addEvent('bot1', 1, `Event ${i}`, 'production');
      }

      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/bot1/history?limit=3&offset=0');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.total).toBe(10);
      expect(data.events.length).toBe(3);
      expect(data.events[0].reason).toBe('Event 9');
    });

    test('respects offset parameter', async () => {
      for (let i = 0; i < 5; i++) {
        service.addEvent('bot1', 1, `Event ${i}`, 'production');
      }

      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/bot1/history?limit=2&offset=2');
      const data = await res.json();

      expect(data.events.length).toBe(2);
      expect(data.events[0].reason).toBe('Event 2');
    });

    test('uses default limit of 50', async () => {
      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/bot1/history');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.total).toBe(0);
      expect(data.events.length).toBe(0);
    });

    test('returns 404 for unknown bot', async () => {
      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/unknown/history');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /:botId/events', () => {
    test('clears all events and returns initial score', async () => {
      service.addEvent('bot1', 10, 'Good work', 'production');
      service.addEvent('bot1', -3, 'Bad work', 'agent-loop');

      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/bot1/events', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.score).toBe(50);

      // Verify events are actually cleared
      expect(service.getAllEvents('bot1').length).toBe(0);
    });

    test('returns 404 for unknown bot', async () => {
      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/unknown/events', {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Bot not found');
    });

    test('works on bot with no events', async () => {
      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/bot1/events', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.score).toBe(50);
    });
  });

  describe('POST /:botId/adjust', () => {
    test('creates a manual karma adjustment', async () => {
      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/bot1/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: -10, reason: 'Repeated low quality' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.event.delta).toBe(-10);
      expect(data.event.reason).toBe('Repeated low quality');
      expect(data.event.source).toBe('manual');
      expect(data.score).toBe(40);
    });

    test('returns 404 for unknown bot', async () => {
      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/unknown/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: 5, reason: 'Test' }),
      });

      expect(res.status).toBe(404);
    });

    test('returns 400 when delta is missing', async () => {
      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/bot1/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'No delta' }),
      });

      expect(res.status).toBe(400);
    });

    test('returns 400 when reason is missing', async () => {
      const app = makeApp(service);
      const res = await app.request('http://localhost/api/karma/bot1/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: 5 }),
      });

      expect(res.status).toBe(400);
    });
  });
});

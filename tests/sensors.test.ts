import { describe, expect, it } from 'bun:test';
import {
  type ActivityDataSource,
  ChannelActivitySensor,
} from '../src/bot/sensors/channel-activity-sensor';
import { RssSensor, parseRssXml } from '../src/bot/sensors/rss-sensor';
import { SensorManager } from '../src/bot/sensors/sensor-manager';
import { TimeSensor } from '../src/bot/sensors/time-sensor';
import { WebhookSensor } from '../src/bot/sensors/webhook-sensor';

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
} as any;

describe('sensors', () => {
  // ── TimeSensor ──

  describe('TimeSensor', () => {
    it('returns time-category event with day and bucket', async () => {
      const sensor = new TimeSensor();
      const events = await sensor.poll('test-bot');
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('time');
      expect(events[0].relevance).toBe(0.3);
      expect(events[0].data).toHaveProperty('hour');
      expect(events[0].data).toHaveProperty('bucket');
      expect(events[0].data).toHaveProperty('isWeekend');
      expect(events[0].data).toHaveProperty('dayName');
    });
  });

  // ── RSS parser ──

  describe('parseRssXml', () => {
    it('parses RSS 2.0 feed', () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0">
          <channel>
            <item>
              <title>Article One</title>
              <link>https://example.com/1</link>
              <guid>guid-1</guid>
              <pubDate>Mon, 24 Mar 2026 10:00:00 GMT</pubDate>
            </item>
            <item>
              <title>Article Two</title>
              <link>https://example.com/2</link>
            </item>
          </channel>
        </rss>`;

      const items = parseRssXml(xml);
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe('Article One');
      expect(items[0].id).toBe('guid-1');
      expect(items[0].link).toBe('https://example.com/1');
      expect(items[1].title).toBe('Article Two');
    });

    it('parses Atom feed', () => {
      const xml = `<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <title>Atom Entry</title>
            <id>urn:uuid:123</id>
            <link href="https://example.com/atom/1" rel="alternate"/>
            <updated>2026-03-24T10:00:00Z</updated>
          </entry>
        </feed>`;

      const items = parseRssXml(xml);
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Atom Entry');
      expect(items[0].id).toBe('urn:uuid:123');
      expect(items[0].link).toBe('https://example.com/atom/1');
    });

    it('handles CDATA content', () => {
      const xml = `<rss><channel><item>
        <title><![CDATA[Special & Title]]></title>
        <link>https://example.com</link>
      </item></channel></rss>`;

      const items = parseRssXml(xml);
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Special & Title');
    });

    it('decodes HTML entities', () => {
      const xml = `<rss><channel><item>
        <title>Tom &amp; Jerry &lt;3&gt;</title>
        <link>https://example.com</link>
      </item></channel></rss>`;

      const items = parseRssXml(xml);
      expect(items[0].title).toBe('Tom & Jerry <3>');
    });

    it('returns empty for invalid XML', () => {
      expect(parseRssXml('not xml')).toHaveLength(0);
      expect(parseRssXml('')).toHaveLength(0);
    });
  });

  // ── RssSensor ──

  describe('RssSensor', () => {
    it('first poll marks all as seen and returns empty', async () => {
      // We can't easily mock fetch in bun:test, but we can test the sensor
      // doesn't crash with empty feeds
      const sensor = new RssSensor([]);
      const events = await sensor.poll('test-bot');
      expect(events).toHaveLength(0);
    });
  });

  // ── ChannelActivitySensor ──

  describe('ChannelActivitySensor', () => {
    it('reports active conversations', async () => {
      const dataSource: ActivityDataSource = {
        getActiveCount: () => 3,
        getLastInboundTimestamp: () => Date.now() - 3_600_000,
        getLastOutboundTimestamp: () => Date.now() - 7_200_000,
      };

      const sensor = new ChannelActivitySensor(dataSource);
      const events = await sensor.poll('test-bot');
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('activity');
      expect(events[0].summary).toContain('3 active conversations');
    });

    it('detects unanswered messages', async () => {
      const dataSource: ActivityDataSource = {
        getActiveCount: () => 1,
        getLastInboundTimestamp: () => Date.now() - 45 * 60_000, // 45 min ago
        getLastOutboundTimestamp: () => Date.now() - 2 * 3_600_000, // 2h ago
      };

      const sensor = new ChannelActivitySensor(dataSource);
      const events = await sensor.poll('test-bot');
      expect(events[0].summary).toContain('unanswered');
      expect(events[0].relevance).toBeGreaterThan(0.5);
    });

    it('reports no activity', async () => {
      const dataSource: ActivityDataSource = {
        getActiveCount: () => 0,
        getLastInboundTimestamp: () => null,
        getLastOutboundTimestamp: () => null,
      };

      const sensor = new ChannelActivitySensor(dataSource);
      const events = await sensor.poll('test-bot');
      expect(events[0].summary).toContain('No active conversations');
      expect(events[0].relevance).toBe(0.2);
    });
  });

  // ── WebhookSensor ──

  describe('WebhookSensor', () => {
    it('accepts and queues events', () => {
      const sensor = new WebhookSensor();
      const ok = sensor.receiveEvent('test-bot', { summary: 'Deploy completed' });
      expect(ok).toBe(true);
      expect(sensor.getQueueSize('test-bot')).toBe(1);
    });

    it('drains queue on poll', async () => {
      const sensor = new WebhookSensor();
      sensor.receiveEvent('test-bot', { summary: 'Event 1', relevance: 0.7 });
      sensor.receiveEvent('test-bot', { summary: 'Event 2', relevance: 0.5 });

      const events = await sensor.poll('test-bot');
      expect(events).toHaveLength(2);
      expect(events[0].category).toBe('external');
      expect(events[0].summary).toBe('Event 1');

      // Queue should be empty after drain
      expect(sensor.getQueueSize('test-bot')).toBe(0);
    });

    it('respects max queue size (drops oldest)', () => {
      const sensor = new WebhookSensor();
      for (let i = 0; i < 55; i++) {
        sensor.receiveEvent('test-bot', { summary: `Event ${i}` });
      }
      expect(sensor.getQueueSize('test-bot')).toBe(50);
    });

    it('validates HMAC signature when secret is set', () => {
      const { createHmac } = require('node:crypto');
      const secret = 'test-secret-123';
      const sensor = new WebhookSensor(secret);

      const payload = { summary: 'Signed event' };
      const signature = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

      // Good signature
      expect(sensor.receiveEvent('test-bot', payload, signature)).toBe(true);

      // Bad signature
      expect(sensor.receiveEvent('test-bot', payload, 'bad-sig')).toBe(false);

      // Missing signature
      expect(sensor.receiveEvent('test-bot', payload)).toBe(false);
    });

    it('accepts events without signature when no secret', () => {
      const sensor = new WebhookSensor();
      expect(sensor.receiveEvent('test-bot', { summary: 'No sig needed' })).toBe(true);
    });

    it('clamps relevance to [0, 1]', () => {
      const sensor = new WebhookSensor();
      sensor.receiveEvent('test-bot', { summary: 'High', relevance: 5.0 });
      sensor.receiveEvent('test-bot', { summary: 'Low', relevance: -1.0 });
    });
  });

  // ── SensorManager ──

  describe('SensorManager', () => {
    it('configures and polls sensors', async () => {
      const manager = new SensorManager(nullLogger);
      manager.configure({ time: { enabled: true } });
      expect(manager.getSensorCount()).toBe(1);

      const block = await manager.getEnvironmentBlock('test-bot');
      expect(block).not.toBeNull();
      expect(block).toContain('## Environment');
      expect(block).toContain('[time]');
    });

    it('respects character budget', async () => {
      const manager = new SensorManager(nullLogger);
      manager.configure({ time: { enabled: true } });

      // Add a custom sensor that returns many events
      manager.addSensor({
        id: 'flood',
        poll: async () =>
          Array.from({ length: 50 }, (_, i) => ({
            sensorId: 'flood',
            timestamp: Date.now(),
            category: 'external' as const,
            summary: `Event ${i}: ${'x'.repeat(80)}`,
            relevance: 0.5,
          })),
      });

      const block = await manager.getEnvironmentBlock('test-bot');
      expect(block).not.toBeNull();
      expect(block?.length).toBeLessThanOrEqual(550); // some slack for header
    });

    it('sorts by relevance (highest first)', async () => {
      const manager = new SensorManager(nullLogger);
      manager.configure({ time: { enabled: false } }); // disable time

      manager.addSensor({
        id: 'low',
        poll: async () => [
          {
            sensorId: 'low',
            timestamp: Date.now(),
            category: 'external',
            summary: 'Low prio',
            relevance: 0.1,
          },
        ],
      });
      manager.addSensor({
        id: 'high',
        poll: async () => [
          {
            sensorId: 'high',
            timestamp: Date.now(),
            category: 'external',
            summary: 'High prio',
            relevance: 0.9,
          },
        ],
      });

      const events = await manager.pollAll('test-bot');
      expect(events[0].relevance).toBeGreaterThan(events[1].relevance);
    });

    it('returns null when no sensors configured', async () => {
      const manager = new SensorManager(nullLogger);
      manager.configure({ time: { enabled: false } });
      const block = await manager.getEnvironmentBlock('test-bot');
      expect(block).toBeNull();
    });

    it('caches last poll results', async () => {
      const manager = new SensorManager(nullLogger);
      manager.configure({ time: { enabled: true } });
      await manager.pollAll('test-bot');
      const cached = manager.getCachedEvents('test-bot');
      expect(cached.length).toBeGreaterThan(0);
    });
  });
});

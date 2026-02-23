import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KarmaService } from '../src/karma/service';
import type { KarmaConfig } from '../src/karma/service';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

const TEST_DIR = join(process.cwd(), '.test-karma');

function makeConfig(overrides?: Partial<KarmaConfig>): KarmaConfig {
  return {
    enabled: true,
    baseDir: TEST_DIR,
    initialScore: 50,
    decayDays: 30,
    ...overrides,
  };
}

describe('KarmaService', () => {
  let service: KarmaService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new KarmaService(makeConfig(), noopLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('addEvent', () => {
    test('creates event with generated id', () => {
      const event = service.addEvent('bot1', 5, 'Good work', 'production');
      expect(event.id).toBeTruthy();
      expect(event.botId).toBe('bot1');
      expect(event.delta).toBe(5);
      expect(event.reason).toBe('Good work');
      expect(event.source).toBe('production');
      expect(event.timestamp).toBeTruthy();
    });

    test('persists events to JSONL file', () => {
      service.addEvent('bot1', 5, 'Test event', 'production');
      service.addEvent('bot1', -3, 'Bad work', 'agent-loop');

      const eventsPath = join(TEST_DIR, 'bot1', 'events.jsonl');
      expect(existsSync(eventsPath)).toBe(true);

      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);
    });

    test('stores metadata when provided', () => {
      const event = service.addEvent('bot1', 5, 'Test', 'production', { rating: 4 });
      expect(event.metadata).toEqual({ rating: 4 });
    });

    test('creates separate directories per bot', () => {
      service.addEvent('bot1', 5, 'Test', 'production');
      service.addEvent('bot2', -3, 'Test', 'agent-loop');

      expect(existsSync(join(TEST_DIR, 'bot1', 'events.jsonl'))).toBe(true);
      expect(existsSync(join(TEST_DIR, 'bot2', 'events.jsonl'))).toBe(true);
    });
  });

  describe('getScore', () => {
    test('returns initial score with no events', () => {
      const score = service.getScore('bot1');
      expect(score).toBe(50);
    });

    test('adds positive deltas', () => {
      service.addEvent('bot1', 10, 'Good', 'production');
      service.addEvent('bot1', 5, 'Also good', 'production');
      expect(service.getScore('bot1')).toBe(65);
    });

    test('subtracts negative deltas', () => {
      service.addEvent('bot1', -10, 'Bad', 'production');
      expect(service.getScore('bot1')).toBe(40);
    });

    test('clamps score between 0 and 100', () => {
      // Push above 100
      service.addEvent('bot1', 60, 'Very good', 'production');
      expect(service.getScore('bot1')).toBe(100);

      // New service, push below 0
      const svc2 = new KarmaService(makeConfig(), noopLogger);
      svc2.addEvent('bot2', -60, 'Very bad', 'production');
      expect(svc2.getScore('bot2')).toBe(0);
    });

    test('mixed positive and negative events', () => {
      service.addEvent('bot1', 10, 'Good', 'production');
      service.addEvent('bot1', -5, 'Bad', 'agent-loop');
      service.addEvent('bot1', 3, 'OK', 'feedback');
      // 50 + 10 - 5 + 3 = 58
      expect(service.getScore('bot1')).toBe(58);
    });
  });

  describe('getTrend', () => {
    test('returns stable with no events', () => {
      expect(service.getTrend('bot1')).toBe('stable');
    });

    test('returns rising when recent delta > 2', () => {
      service.addEvent('bot1', 5, 'Good', 'production');
      expect(service.getTrend('bot1')).toBe('rising');
    });

    test('returns falling when recent delta < -2', () => {
      service.addEvent('bot1', -5, 'Bad', 'production');
      expect(service.getTrend('bot1')).toBe('falling');
    });

    test('returns stable when delta is within [-2, 2]', () => {
      service.addEvent('bot1', 1, 'OK', 'production');
      service.addEvent('bot1', -1, 'Meh', 'agent-loop');
      expect(service.getTrend('bot1')).toBe('stable');
    });
  });

  describe('getKarmaScore', () => {
    test('returns combined score object', () => {
      service.addEvent('bot1', 5, 'Test', 'production');
      const result = service.getKarmaScore('bot1');

      expect(result.botId).toBe('bot1');
      expect(result.current).toBe(55);
      expect(result.trend).toBe('rising');
      expect(result.recentEvents.length).toBe(1);
    });
  });

  describe('getRecentEvents', () => {
    test('returns events in reverse order (newest first)', () => {
      service.addEvent('bot1', 1, 'First', 'production');
      service.addEvent('bot1', 2, 'Second', 'production');
      service.addEvent('bot1', 3, 'Third', 'production');

      const recent = service.getRecentEvents('bot1');
      expect(recent.length).toBe(3);
      expect(recent[0].reason).toBe('Third');
      expect(recent[2].reason).toBe('First');
    });

    test('respects limit', () => {
      for (let i = 0; i < 15; i++) {
        service.addEvent('bot1', 1, `Event ${i}`, 'production');
      }

      const recent = service.getRecentEvents('bot1', 5);
      expect(recent.length).toBe(5);
    });

    test('returns empty for unknown bot', () => {
      expect(service.getRecentEvents('unknown')).toEqual([]);
    });
  });

  describe('renderForPrompt', () => {
    test('includes score and trend', () => {
      service.addEvent('bot1', 5, 'Good production', 'production');
      const block = service.renderForPrompt('bot1');

      expect(block).toContain('55/100');
      expect(block).toContain('rising');
      expect(block).toContain('+5: Good production');
      expect(block).toContain('QUALITY');
    });

    test('renders for bot with no events', () => {
      const block = service.renderForPrompt('bot1');
      expect(block).toContain('50/100');
      expect(block).toContain('stable');
    });
  });

  describe('renderShort', () => {
    test('returns single-line karma summary', () => {
      const line = service.renderShort('bot1');
      expect(line).toBe('## Karma: 50/100 (stable)');
    });
  });

  describe('getAllScores', () => {
    test('returns scores for multiple bots', () => {
      service.addEvent('bot1', 5, 'Test', 'production');
      service.addEvent('bot2', -3, 'Test', 'agent-loop');

      const scores = service.getAllScores(['bot1', 'bot2', 'bot3']);
      expect(scores.length).toBe(3);
      expect(scores[0].current).toBe(55);
      expect(scores[1].current).toBe(47);
      expect(scores[2].current).toBe(50); // no events
    });
  });

  describe('clearEvents', () => {
    test('clears all events for a bot', () => {
      service.addEvent('bot1', 5, 'Good', 'production');
      service.addEvent('bot1', -3, 'Bad', 'agent-loop');
      expect(service.getAllEvents('bot1').length).toBe(2);

      service.clearEvents('bot1');
      expect(service.getAllEvents('bot1').length).toBe(0);
    });

    test('score returns to initial after clear', () => {
      service.addEvent('bot1', 10, 'Good', 'production');
      expect(service.getScore('bot1')).toBe(60);

      service.clearEvents('bot1');
      expect(service.getScore('bot1')).toBe(50);
    });

    test('does not affect other bots', () => {
      service.addEvent('bot1', 5, 'Good', 'production');
      service.addEvent('bot2', 10, 'Great', 'production');

      service.clearEvents('bot1');

      expect(service.getAllEvents('bot1').length).toBe(0);
      expect(service.getAllEvents('bot2').length).toBe(1);
      expect(service.getScore('bot2')).toBe(60);
    });

    test('works on bot with no events', () => {
      service.clearEvents('bot1');
      expect(service.getAllEvents('bot1').length).toBe(0);
      expect(service.getScore('bot1')).toBe(50);
    });
  });

  describe('getHistory', () => {
    test('returns paginated history newest first', () => {
      for (let i = 0; i < 10; i++) {
        service.addEvent('bot1', 1, `Event ${i}`, 'production');
      }

      const page1 = service.getHistory('bot1', { limit: 3, offset: 0 });
      expect(page1.total).toBe(10);
      expect(page1.events.length).toBe(3);
      expect(page1.events[0].reason).toBe('Event 9'); // newest first

      const page2 = service.getHistory('bot1', { limit: 3, offset: 3 });
      expect(page2.events.length).toBe(3);
      expect(page2.events[0].reason).toBe('Event 6');
    });

    test('returns empty for unknown bot', () => {
      const result = service.getHistory('unknown');
      expect(result.total).toBe(0);
      expect(result.events.length).toBe(0);
    });
  });
});

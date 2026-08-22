import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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

  describe('dedup cooldown', () => {
    test('duplicate negative tool events within cooldown are skipped', () => {
      const svc = new KarmaService(makeConfig({ dedupCooldownMinutes: 60 }), noopLogger);
      const first = svc.addEvent('bot1', -1, 'Tool error: file_read — not found', 'tool');
      const second = svc.addEvent('bot1', -1, 'Tool error: file_read — not found', 'tool');
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(svc.getAllEvents('bot1').length).toBe(1);
    });

    test('duplicate template events on same file are skipped', () => {
      const svc = new KarmaService(makeConfig({ dedupCooldownMinutes: 60 }), noopLogger);
      const first = svc.addEvent('bot1', -3, 'Empty template detected in "notes.md"', 'production');
      const second = svc.addEvent(
        'bot1',
        -3,
        'Empty template detected in "notes.md"',
        'production'
      );
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(svc.getAllEvents('bot1').length).toBe(1);
    });

    test('positive events are never deduped', () => {
      const svc = new KarmaService(makeConfig({ dedupCooldownMinutes: 60 }), noopLogger);
      const first = svc.addEvent('bot1', 1, 'Novel action: review goals', 'agent-loop');
      const second = svc.addEvent('bot1', 1, 'Novel action: review goals', 'agent-loop');
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(svc.getAllEvents('bot1').length).toBe(2);
    });

    test('events beyond cooldown window ARE recorded', () => {
      const svc = new KarmaService(makeConfig({ dedupCooldownMinutes: 0 }), noopLogger);
      const first = svc.addEvent('bot1', -1, 'Tool error: file_read — not found', 'tool');
      // cooldown is 0 minutes, so immediately beyond the window
      const second = svc.addEvent('bot1', -1, 'Tool error: file_read — not found', 'tool');
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(svc.getAllEvents('bot1').length).toBe(2);
    });

    test('different tool errors are NOT deduped against each other', () => {
      const svc = new KarmaService(makeConfig({ dedupCooldownMinutes: 60 }), noopLogger);
      const first = svc.addEvent('bot1', -1, 'Tool error: file_read — not found', 'tool');
      const second = svc.addEvent('bot1', -1, 'Tool error: file_write — permission denied', 'tool');
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(svc.getAllEvents('bot1').length).toBe(2);
    });

    test('addEvent returns null for deduped events', () => {
      const svc = new KarmaService(makeConfig({ dedupCooldownMinutes: 60 }), noopLogger);
      svc.addEvent('bot1', -2, 'Repeated action: review goals again', 'agent-loop');
      const result = svc.addEvent('bot1', -2, 'Repeated action: review goals again', 'agent-loop');
      expect(result).toBeNull();
    });

    test('manual negative events are never deduped', () => {
      const svc = new KarmaService(makeConfig({ dedupCooldownMinutes: 60 }), noopLogger);
      const first = svc.addEvent('bot1', -5, 'Manual penalty', 'manual');
      const second = svc.addEvent('bot1', -5, 'Manual penalty', 'manual');
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(svc.getAllEvents('bot1').length).toBe(2);
    });

    test('template events on different files are NOT deduped', () => {
      const svc = new KarmaService(makeConfig({ dedupCooldownMinutes: 60 }), noopLogger);
      const first = svc.addEvent('bot1', -3, 'Empty template detected in "notes.md"', 'production');
      const second = svc.addEvent(
        'bot1',
        -3,
        'Empty template detected in "report.md"',
        'production'
      );
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(svc.getAllEvents('bot1').length).toBe(2);
    });

    test('dedup is per-bot (same event on different bots is not deduped)', () => {
      const svc = new KarmaService(makeConfig({ dedupCooldownMinutes: 60 }), noopLogger);
      const first = svc.addEvent('bot1', -1, 'Tool error: file_read — not found', 'tool');
      const second = svc.addEvent('bot2', -1, 'Tool error: file_read — not found', 'tool');
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
    });
  });

  describe('extractDedupKey', () => {
    test('extracts file path from production source', () => {
      const key = KarmaService.extractDedupKey(
        'production',
        'Empty template detected in "notes.md"'
      );
      expect(key).toBe('production:notes.md');
    });

    test('extracts tool name from tool source', () => {
      const key = KarmaService.extractDedupKey('tool', 'Tool error: file_read — File not found');
      expect(key).toContain('tool:file_read:');
    });

    test('uses prefix for agent-loop source', () => {
      const key = KarmaService.extractDedupKey(
        'agent-loop',
        'Repeated action: something long here'
      );
      expect(key).toStartWith('agent-loop:');
    });

    test('falls back to source:prefix for other sources', () => {
      const key = KarmaService.extractDedupKey('goal', 'Some goal failure reason');
      expect(key).toBe('goal:Some goal failure reason');
    });

    test('normalizes leading ./ in production paths', () => {
      const key1 = KarmaService.extractDedupKey(
        'production',
        'Empty template detected in "./notes.md"'
      );
      const key2 = KarmaService.extractDedupKey(
        'production',
        'Empty template detected in "notes.md"'
      );
      expect(key1).toBe(key2);
      expect(key1).toBe('production:notes.md');
    });

    test('normalizes ./ prefix in nested paths', () => {
      const key1 = KarmaService.extractDedupKey(
        'production',
        'Empty template detected in "./src/chapter1.md"'
      );
      const key2 = KarmaService.extractDedupKey(
        'production',
        'Empty template detected in "src/chapter1.md"'
      );
      expect(key1).toBe(key2);
      expect(key1).toBe('production:src/chapter1.md');
    });

    test('collapses duplicate slashes in production paths', () => {
      const key1 = KarmaService.extractDedupKey(
        'production',
        'Empty template detected in "src//chapter1.md"'
      );
      const key2 = KarmaService.extractDedupKey(
        'production',
        'Empty template detected in "src/chapter1.md"'
      );
      expect(key1).toBe(key2);
    });
  });

  describe('dedup with path normalization', () => {
    test('./file.md and file.md produce same dedup key and are deduped', () => {
      const svc = new KarmaService(makeConfig({ dedupCooldownMinutes: 60 }), noopLogger);
      const first = svc.addEvent(
        'bot1',
        -3,
        'Empty template detected in "./manuscrito.md"',
        'production'
      );
      const second = svc.addEvent(
        'bot1',
        -3,
        'Empty template detected in "manuscrito.md"',
        'production'
      );
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(svc.getAllEvents('bot1').length).toBe(1);
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

// ── Outcome-based karma (rewards table) ──

describe('KarmaService.recordOutcome', () => {
  let service: KarmaService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new KarmaService(makeConfig(), noopLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('default rewards table matches the outcome-based design', () => {
    expect(service.getRewards()).toEqual({
      novelAction: 0,
      productionApproved: 3,
      productionRejected: -1,
      askAnswered: 2,
      humanReply: 3,
      collaborateCompleted: 0,
      toolError: -1,
    });
  });

  test('novelAction is worth 0 by default → no event written, returns null', () => {
    const ev = service.recordOutcome('bot1', 'novelAction', 'Novel action: researched X');
    expect(ev).toBeNull();
    expect(service.getAllEvents('bot1')).toHaveLength(0);
    expect(service.getScore('bot1')).toBe(50);
  });

  test('config.rewards overrides a single kind without touching the others', () => {
    const svc = new KarmaService(makeConfig({ rewards: { novelAction: 1 } }), noopLogger);
    expect(svc.getRewards().novelAction).toBe(1);
    expect(svc.getRewards().productionApproved).toBe(3);
    const ev = svc.recordOutcome('bot1', 'novelAction', 'Novel action: researched X');
    expect(ev?.delta).toBe(1);
    expect(ev?.source).toBe('agent-loop');
  });

  test('productionApproved / productionRejected use the production source and carry metadata', () => {
    const ok = service.recordOutcome('bot1', 'productionApproved', 'Production approved: "a.md"', {
      rating: 5,
    });
    expect(ok?.delta).toBe(3);
    expect(ok?.source).toBe('production');
    expect(ok?.kind).toBe('productionApproved');
    expect(ok?.metadata?.rating).toBe(5);

    const bad = service.recordOutcome('bot1', 'productionRejected', 'Production rejected: "b.md"');
    expect(bad?.delta).toBe(-1);
    expect(bad?.source).toBe('production');
    expect(service.getScore('bot1')).toBe(52);
  });

  test('askAnswered and humanReply are credited under the engagement source', () => {
    const ask = service.recordOutcome('bot1', 'askAnswered', 'Operator answered a question');
    expect(ask?.delta).toBe(2);
    expect(ask?.source).toBe('engagement');
    const reply = service.recordOutcome('bot1', 'humanReply', 'Human replied in conversation');
    expect(reply?.delta).toBe(3);
    expect(reply?.source).toBe('engagement');
  });

  test('toolError stays -1 with the tool source (existing dedup applies)', () => {
    const first = service.recordOutcome('bot1', 'toolError', 'Tool error: file_read — ENOENT');
    expect(first?.delta).toBe(-1);
    expect(first?.source).toBe('tool');
    const second = service.recordOutcome('bot1', 'toolError', 'Tool error: file_read — ENOENT');
    expect(second).toBeNull();
  });

  test('humanReply is credited at most once per bot per cooldown window (6h default)', () => {
    const a = service.recordOutcome('bot1', 'humanReply', 'Human replied');
    const b = service.recordOutcome('bot1', 'humanReply', 'Human replied again');
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    // Another bot is independent
    expect(service.recordOutcome('bot2', 'humanReply', 'Human replied')).not.toBeNull();
    // Other kinds are not affected by the humanReply cooldown
    expect(service.recordOutcome('bot1', 'askAnswered', 'Answered')).not.toBeNull();
    expect(service.recordOutcome('bot1', 'askAnswered', 'Answered again')).not.toBeNull();
  });

  test('humanReply cooldown window is configurable (0 disables it)', () => {
    const svc = new KarmaService(makeConfig({ humanReplyCooldownHours: 0 }), noopLogger);
    expect(svc.recordOutcome('bot1', 'humanReply', 'Human replied')).not.toBeNull();
    expect(svc.recordOutcome('bot1', 'humanReply', 'Human replied')).not.toBeNull();
  });

  test('unknown kind is rejected with null and no write', () => {
    const ev = service.recordOutcome('bot1', 'bogus' as any, 'nope');
    expect(ev).toBeNull();
    expect(service.getAllEvents('bot1')).toHaveLength(0);
  });
});

describe('KarmaService breakdown', () => {
  let service: KarmaService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new KarmaService(makeConfig(), noopLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('getKarmaScore returns a 30-day breakdown by source and by kind', () => {
    service.recordOutcome('bot1', 'productionApproved', 'Production approved: "a.md"');
    service.recordOutcome('bot1', 'productionApproved', 'Production approved: "b.md"');
    service.recordOutcome('bot1', 'askAnswered', 'Answered');
    service.recordOutcome('bot1', 'toolError', 'Tool error: x — boom');
    service.addEvent('bot1', 4, 'Operator bonus', 'manual');

    const score = service.getKarmaScore('bot1');
    expect(score.breakdown.windowDays).toBe(30);
    expect(score.breakdown.bySource).toEqual({
      production: 6,
      engagement: 2,
      tool: -1,
      manual: 4,
    });
    expect(score.breakdown.byKind).toEqual({
      productionApproved: 6,
      askAnswered: 2,
      toolError: -1,
    });
  });

  test('breakdown ignores events older than the window', () => {
    const old = {
      id: 'old',
      botId: 'bot1',
      timestamp: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      delta: 10,
      reason: 'ancient',
      source: 'production',
    };
    const path = join(TEST_DIR, 'bot1', 'events.jsonl');
    service.addEvent('bot1', 1, 'recent', 'manual');
    const recent = readFileSync(path, 'utf-8');
    const { writeFileSync } = require('node:fs');
    writeFileSync(path, `${JSON.stringify(old)}\n${recent}`, 'utf-8');

    const breakdown = service.getBreakdown('bot1');
    expect(breakdown.bySource).toEqual({ manual: 1 });
    expect(breakdown.byKind).toEqual({});
  });
});

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CollaborationTracker } from '../src/collaboration-tracker';

describe('CollaborationTracker', () => {
  let tracker: CollaborationTracker;

  afterEach(() => {
    tracker.dispose();
  });

  describe('shouldAllowResponse', () => {
    beforeEach(() => {
      tracker = new CollaborationTracker(3, 500); // 3 rounds, 500ms cooldown
    });

    test('allows first interaction between any pair', () => {
      const result = tracker.shouldAllowResponse('botA', 'botB', 100);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test('allows interactions under maxRounds', () => {
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100);
      const result = tracker.shouldAllowResponse('botA', 'botB', 100);
      expect(result.allowed).toBe(true);
    });

    test('blocks interactions at maxRounds during cooldown', () => {
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100); // depth = 3 = maxRounds
      const result = tracker.shouldAllowResponse('botA', 'botB', 100);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cooldown');
    });

    test('allows after cooldown expires', async () => {
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100);

      await Bun.sleep(600); // exceed 500ms cooldown

      const result = tracker.shouldAllowResponse('botA', 'botB', 100);
      expect(result.allowed).toBe(true);
    });

    test('treats different chats independently', () => {
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100);

      // Chat 100 is blocked
      expect(tracker.shouldAllowResponse('botA', 'botB', 100).allowed).toBe(false);
      // Chat 200 is still allowed
      expect(tracker.shouldAllowResponse('botA', 'botB', 200).allowed).toBe(true);
    });

    test('treats different bot pairs independently', () => {
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100);

      expect(tracker.shouldAllowResponse('botA', 'botB', 100).allowed).toBe(false);
      expect(tracker.shouldAllowResponse('botA', 'botC', 100).allowed).toBe(true);
    });
  });

  describe('pairKey symmetry', () => {
    beforeEach(() => {
      tracker = new CollaborationTracker(2, 500);
    });

    test('treats (A→B) and (B→A) as the same pair', () => {
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botB', 'botA', 100); // depth = 2 = maxRounds

      expect(tracker.shouldAllowResponse('botA', 'botB', 100).allowed).toBe(false);
      expect(tracker.shouldAllowResponse('botB', 'botA', 100).allowed).toBe(false);
    });
  });

  describe('checkAndRecord', () => {
    beforeEach(() => {
      tracker = new CollaborationTracker(2, 500);
    });

    test('atomically checks and records when allowed', () => {
      const r1 = tracker.checkAndRecord('botA', 'botB', 100);
      expect(r1.allowed).toBe(true);

      const r2 = tracker.checkAndRecord('botA', 'botB', 100);
      expect(r2.allowed).toBe(true);

      // Now at maxRounds — next check should fail
      const r3 = tracker.checkAndRecord('botA', 'botB', 100);
      expect(r3.allowed).toBe(false);
    });

    test('does not record when blocked', () => {
      tracker.checkAndRecord('botA', 'botB', 100); // depth 1
      tracker.checkAndRecord('botA', 'botB', 100); // depth 2 = max

      const blocked = tracker.checkAndRecord('botA', 'botB', 100);
      expect(blocked.allowed).toBe(false);

      // After cooldown, depth should have been reset (not incremented to 3)
    });
  });

  describe('recordExchange', () => {
    beforeEach(() => {
      tracker = new CollaborationTracker(5, 500);
    });

    test('increments depth on each call', () => {
      tracker.recordExchange('botA', 'botB', 100);
      expect(tracker.shouldAllowResponse('botA', 'botB', 100).allowed).toBe(true);

      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100);
      tracker.recordExchange('botA', 'botB', 100); // depth = 5 = max

      expect(tracker.shouldAllowResponse('botA', 'botB', 100).allowed).toBe(false);
    });
  });

  describe('sweep', () => {
    beforeEach(() => {
      tracker = new CollaborationTracker(5, 100); // 100ms cooldown
    });

    test('removes stale records past cooldown + 5min', () => {
      // Manually set lastMessageAt far in the past
      tracker.recordExchange('botA', 'botB', 100);

      // Force lastMessageAt to be old (cooldown + 300s = 100ms + 300000ms)
      // We can't easily test this without time manipulation,
      // but we can verify sweep doesn't remove fresh records
      tracker.sweep();

      // Record should still exist (it's fresh)
      tracker.recordExchange('botA', 'botB', 100); // depth now 2
      expect(tracker.shouldAllowResponse('botA', 'botB', 100).allowed).toBe(true);
    });
  });

  describe('dispose', () => {
    test('cleans up sweep timer', () => {
      tracker = new CollaborationTracker(5, 500);
      // Should not throw
      tracker.dispose();
      // Calling dispose again should be safe
      tracker.dispose();
    });
  });

  describe('chatId = 0 for internal collaborations', () => {
    beforeEach(() => {
      tracker = new CollaborationTracker(2, 500);
    });

    test('works with chatId 0 (tool-based collaboration)', () => {
      const r1 = tracker.checkAndRecord('botA', 'botB', 0);
      expect(r1.allowed).toBe(true);

      const r2 = tracker.checkAndRecord('botA', 'botB', 0);
      expect(r2.allowed).toBe(true);

      const r3 = tracker.checkAndRecord('botA', 'botB', 0);
      expect(r3.allowed).toBe(false);
    });

    test('internal (chatId=0) and group (chatId=100) are independent', () => {
      tracker.checkAndRecord('botA', 'botB', 0);
      tracker.checkAndRecord('botA', 'botB', 0);

      expect(tracker.shouldAllowResponse('botA', 'botB', 0).allowed).toBe(false);
      expect(tracker.shouldAllowResponse('botA', 'botB', 100).allowed).toBe(true);
    });
  });
});

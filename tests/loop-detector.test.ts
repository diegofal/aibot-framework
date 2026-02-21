import { describe, test, expect, beforeEach } from 'bun:test';
import { createLoopDetector } from '../src/core/loop-detector';

describe('LoopDetector', () => {
  let detector: ReturnType<typeof createLoopDetector>;

  beforeEach(() => {
    detector = createLoopDetector(5); // maxToolRounds = 5, globalLimit = 10
  });

  describe('fresh instance', () => {
    test('returns continue on fresh detector', () => {
      const result = detector.check();
      expect(result.action).toBe('continue');
      expect(result.message).toBeUndefined();
    });
  });

  describe('repeat detection', () => {
    test('allows up to 2 identical calls', () => {
      const args = { url: 'https://example.com' };
      
      detector.recordCall('browser', args, 'result1');
      expect(detector.check().action).toBe('continue');
      
      detector.recordCall('browser', args, 'result2');
      expect(detector.check().action).toBe('continue');
    });

    test('warns on 3 identical calls', () => {
      const args = { url: 'https://example.com' };
      
      detector.recordCall('browser', args, 'result1');
      detector.recordCall('browser', args, 'result2');
      detector.recordCall('browser', args, 'result3');
      
      const result = detector.check();
      expect(result.action).toBe('warn');
      expect(result.message).toContain('repeating');
    });

    test('breaks on 4+ identical calls', () => {
      const args = { url: 'https://example.com' };
      
      for (let i = 0; i < 4; i++) {
        detector.recordCall('browser', args, `result${i}`);
      }
      
      const result = detector.check();
      expect(result.action).toBe('break');
      expect(result.message).toContain('4+ times');
    });

    test('different args reset repeat count', () => {
      detector.recordCall('browser', { url: 'a.com' }, 'result');
      detector.recordCall('browser', { url: 'a.com' }, 'result');
      detector.recordCall('browser', { url: 'b.com' }, 'result'); // different args
      
      // Should be continue because args changed
      expect(detector.check().action).toBe('continue');
    });

    test('different tools tracked separately', () => {
      detector.recordCall('browser', { url: 'x.com' }, 'result');
      detector.recordCall('browser', { url: 'x.com' }, 'result');
      detector.recordCall('file_read', { path: '/tmp' }, 'content'); // different tool
      
      expect(detector.check().action).toBe('continue');
    });
  });

  describe('no-progress detection', () => {
    test('warns when same tool returns identical result twice', () => {
      const sameResult = 'Error: File not found';
      
      detector.recordCall('file_read', { path: '/a' }, sameResult);
      detector.recordCall('file_read', { path: '/b' }, sameResult); // different args, same result
      
      const result = detector.check();
      expect(result.action).toBe('warn');
      expect(result.message).toContain('same result');
    });

    test('breaks when same tool returns identical result 3+ times', () => {
      const sameResult = 'Error: File not found';
      
      detector.recordCall('file_read', { path: '/a' }, sameResult);
      detector.recordCall('file_read', { path: '/b' }, sameResult);
      detector.recordCall('file_read', { path: '/c' }, sameResult);
      
      const result = detector.check();
      expect(result.action).toBe('break');
      expect(result.message).toContain('identical results');
    });

    test('different results do not trigger no-progress', () => {
      detector.recordCall('browser', { url: 'x.com' }, 'Content A');
      detector.recordCall('browser', { url: 'y.com' }, 'Content B');
      
      expect(detector.check().action).toBe('continue');
    });
  });

  describe('global circuit breaker', () => {
    test('breaks when total calls exceed global limit', () => {
      // globalLimit = maxToolRounds * 2 = 10
      for (let i = 0; i < 10; i++) {
        detector.recordCall('tool', { i }, `result${i}`);
      }
      
      const result = detector.check();
      expect(result.action).toBe('break');
      expect(result.message).toContain('10 total tool calls');
    });

    test('continues just below global limit', () => {
      for (let i = 0; i < 9; i++) {
        detector.recordCall('tool', { i }, `result${i}`);
      }
      
      expect(detector.check().action).toBe('continue');
    });

    test('higher maxToolRounds increases global limit', () => {
      const detector20 = createLoopDetector(20); // globalLimit = 40
      
      for (let i = 0; i < 39; i++) {
        detector20.recordCall('tool', { i }, `result${i}`);
      }
      
      expect(detector20.check().action).toBe('continue');
      
      detector20.recordCall('tool', { x: 1 }, 'result');
      expect(detector20.check().action).toBe('break');
    });
  });

  describe('reset', () => {
    test('reset clears all state', () => {
      // Build up some state
      detector.recordCall('browser', { url: 'x.com' }, 'result');
      detector.recordCall('browser', { url: 'x.com' }, 'result');
      detector.recordCall('browser', { url: 'x.com' }, 'result'); // would warn
      
      detector.reset();
      
      const result = detector.check();
      expect(result.action).toBe('continue');
      expect(result.message).toBeUndefined();
    });

    test('reset allows reuse after circuit breaker', () => {
      for (let i = 0; i < 10; i++) {
        detector.recordCall('tool', { i }, `result${i}`);
      }
      expect(detector.check().action).toBe('break');
      
      detector.reset();
      
      detector.recordCall('tool', { fresh: true }, 'new result');
      expect(detector.check().action).toBe('continue');
    });
  });

  describe('result hashing limits', () => {
    test('only hashes first 500 chars of result', () => {
      const longResult = 'a'.repeat(1000);
      const differentAfter500 = 'a'.repeat(500) + 'different';
      
      // These should hash to the same key (first 500 chars identical)
      detector.recordCall('tool', { a: 1 }, longResult);
      detector.recordCall('tool', { b: 2 }, differentAfter500);
      
      // Should trigger no-progress warning (same result hash)
      const result = detector.check();
      expect(result.action).toBe('warn');
    });
  });

  describe('priority of detections', () => {
    test('global circuit breaker takes precedence over repeat', () => {
      // Fill up to global limit with same call
      for (let i = 0; i < 10; i++) {
        detector.recordCall('browser', { url: 'x.com' }, 'result');
      }
      
      const result = detector.check();
      // Global limit (10) hit before repeat limit (4)
      expect(result.action).toBe('break');
      expect(result.message).toContain('10 total');
    });

    test('repeat takes precedence over no-progress', () => {
      // Same call 3 times triggers repeat warning
      // Also same result 2 times would trigger no-progress
      const args = { path: '/test' };
      const result = 'content';
      
      detector.recordCall('file_read', args, result);
      detector.recordCall('file_read', args, result);
      detector.recordCall('file_read', args, result);
      
      const check = detector.check();
      // Repeat detection triggers first (count 3)
      expect(check.action).toBe('warn');
      expect(check.message).toContain('repeating');
    });
  });
});

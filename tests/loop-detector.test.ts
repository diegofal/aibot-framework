import { describe, it, expect } from 'bun:test';
import { createLoopDetector, type LoopDetector } from '../src/core/loop-detector';

describe('LoopDetector', () => {
  describe('Basic functionality', () => {
    it('should create a detector with maxToolRounds', () => {
      const detector = createLoopDetector(10);
      expect(detector).toBeDefined();
      expect(typeof detector.recordCall).toBe('function');
      expect(typeof detector.check).toBe('function');
      expect(typeof detector.reset).toBe('function');
    });

    it('should return continue for fresh detector', () => {
      const detector = createLoopDetector(10);
      const result = detector.check();
      expect(result.action).toBe('continue');
      expect(result.message).toBeUndefined();
    });

    it('should reset all state when reset() is called', () => {
      const detector = createLoopDetector(10);
      
      // Trigger some state
      for (let i = 0; i < 4; i++) {
        detector.recordCall('testTool', { arg: 'value' }, 'result');
      }
      expect(detector.check().action).toBe('break');
      
      // Reset and verify clean state
      detector.reset();
      expect(detector.check().action).toBe('continue');
    });
  });

  describe('Repeat detector - same tool+args', () => {
    it('should warn after 3 identical calls', () => {
      const detector = createLoopDetector(10);
      const args = { query: 'test' };
      
      detector.recordCall('search', args, 'result1');
      expect(detector.check().action).toBe('continue');
      
      detector.recordCall('search', args, 'result2');
      expect(detector.check().action).toBe('continue');
      
      detector.recordCall('search', args, 'result3');
      const check = detector.check();
      expect(check.action).toBe('warn');
      expect(check.message).toContain('repeating the same tool call');
    });

    it('should break after 4 identical calls', () => {
      const detector = createLoopDetector(10);
      const args = { query: 'test' };
      
      for (let i = 0; i < 4; i++) {
        detector.recordCall('search', args, `result${i}`);
      }
      
      const check = detector.check();
      expect(check.action).toBe('break');
      expect(check.message).toContain('Same tool call repeated 4+ times');
    });

    it('should track different args separately', () => {
      const detector = createLoopDetector(10);
      
      // Call same tool with different args AND different results
      // (same result would trigger no-progress detector)
      for (let i = 0; i < 3; i++) {
        detector.recordCall('search', { query: `test${i}` }, `result${i}`);
      }
      
      // Should not warn because args are different
      expect(detector.check().action).toBe('continue');
    });

    it('should track different tools separately', () => {
      const detector = createLoopDetector(10);
      
      // Call different tools with same args
      for (let i = 0; i < 3; i++) {
        detector.recordCall(`tool${i}`, { arg: 'value' }, 'result');
      }
      
      expect(detector.check().action).toBe('continue');
    });

    it('should handle complex nested args correctly', () => {
      const detector = createLoopDetector(10);
      const args = { 
        nested: { deep: { value: 123 } },
        array: [1, 2, 3],
        bool: true
      };
      
      for (let i = 0; i < 3; i++) {
        detector.recordCall('complex', args, 'result');
      }
      
      expect(detector.check().action).toBe('warn');
    });
  });

  describe('No-progress detector - same results', () => {
    it('should warn when same tool returns same result twice', () => {
      const detector = createLoopDetector(10);
      const sameResult = 'identical result string';
      
      // Same tool name, different args, same result
      detector.recordCall('myTool', { a: 1 }, sameResult);
      detector.recordCall('myTool', { b: 2 }, sameResult);
      
      const check = detector.check();
      expect(check.action).toBe('warn');
      expect(check.message).toContain('returning the same result');
    });

    it('should break when same tool returns same result 3 times', () => {
      const detector = createLoopDetector(10);
      const sameResult = 'identical result string';
      
      // Same tool name, different args, same result 3 times
      detector.recordCall('myTool', { a: 1 }, sameResult);
      detector.recordCall('myTool', { b: 2 }, sameResult);
      detector.recordCall('myTool', { c: 3 }, sameResult);
      
      const check = detector.check();
      expect(check.action).toBe('break');
      expect(check.message).toContain('identical results repeatedly');
    });

    it('should hash only first 500 chars of result', () => {
      const detector = createLoopDetector(10);
      const longResult = 'a'.repeat(500) + 'different suffix here';
      const similarResult = 'a'.repeat(500) + 'another different suffix';
      
      // Same tool name for both calls
      detector.recordCall('myTool', { a: 1 }, longResult);
      detector.recordCall('myTool', { b: 2 }, similarResult);
      
      // Should warn because first 500 chars are identical
      expect(detector.check().action).toBe('warn');
    });

    it('should distinguish different results', () => {
      const detector = createLoopDetector(10);
      
      detector.recordCall('tool', { x: 1 }, 'result A');
      detector.recordCall('tool', { x: 2 }, 'result B');
      
      expect(detector.check().action).toBe('continue');
    });
  });

  describe('Global circuit breaker', () => {
    it('should break when total calls exceed 2x maxToolRounds', () => {
      const maxRounds = 5;
      const detector = createLoopDetector(maxRounds);
      
      // Call up to the limit
      for (let i = 0; i < maxRounds * 2; i++) {
        detector.recordCall('tool', { i }, `result${i}`);
      }
      
      const check = detector.check();
      expect(check.action).toBe('break');
      expect(check.message).toContain('Exceeded');
      expect(check.message).toContain(String(maxRounds * 2));
    });

    it('should allow calls up to the limit', () => {
      const maxRounds = 5;
      const detector = createLoopDetector(maxRounds);
      
      // Call just under the limit
      for (let i = 0; i < maxRounds * 2 - 1; i++) {
        detector.recordCall('tool', { i }, `result${i}`);
      }
      
      expect(detector.check().action).toBe('continue');
    });

    it('should count total calls across different tools', () => {
      const maxRounds = 3;
      const detector = createLoopDetector(maxRounds);
      
      // 6 calls across different tools should trigger breaker (limit = 6)
      for (let i = 0; i < 6; i++) {
        detector.recordCall(`tool${i}`, { unique: i }, `result${i}`);
      }
      
      expect(detector.check().action).toBe('break');
    });
  });

  describe('Priority of detection strategies', () => {
    it('should prioritize circuit breaker over repeat detection', () => {
      const maxRounds = 2;
      const detector = createLoopDetector(maxRounds);
      
      // 4 calls with same args would trigger repeat (4+)
      // But circuit breaker triggers at 4 calls (2*2)
      for (let i = 0; i < 4; i++) {
        detector.recordCall('tool', { same: true }, 'different');
      }
      
      const check = detector.check();
      expect(check.action).toBe('break');
      // Circuit breaker message (not repeat message)
      expect(check.message).toContain('Exceeded');
    });

    it('should prioritize repeat detection over no-progress', () => {
      const detector = createLoopDetector(50);
      
      // 3 identical calls (repeat warn) vs 2 same results (no-progress warn)
      detector.recordCall('tool', { arg: 'value' }, 'same');
      detector.recordCall('tool', { arg: 'value' }, 'same');
      detector.recordCall('tool', { arg: 'value' }, 'same');
      
      const check = detector.check();
      expect(check.action).toBe('warn');
      expect(check.message).toContain('repeating');
    });

    it('should break on 4 repeats even with different results', () => {
      const detector = createLoopDetector(50);
      
      // Same args, different results each time
      for (let i = 0; i < 4; i++) {
        detector.recordCall('tool', { arg: 'value' }, `result${i}`);
      }
      
      const check = detector.check();
      expect(check.action).toBe('break');
      expect(check.message).toContain('Same tool call repeated');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty args object', () => {
      const detector = createLoopDetector(10);
      
      for (let i = 0; i < 3; i++) {
        detector.recordCall('tool', {}, 'result');
      }
      
      expect(detector.check().action).toBe('warn');
    });

    it('should handle empty result string', () => {
      const detector = createLoopDetector(10);
      
      // Same tool returning empty string twice
      detector.recordCall('myTool', { a: 1 }, '');
      detector.recordCall('myTool', { b: 2 }, '');
      
      expect(detector.check().action).toBe('warn');
    });

    it('should handle special characters in results', () => {
      const detector = createLoopDetector(10);
      const specialResult = 'result with \n newlines \t tabs "quotes" and unicode: 你好';
      
      // Same tool returning special result twice
      detector.recordCall('myTool', { a: 1 }, specialResult);
      detector.recordCall('myTool', { b: 2 }, specialResult);
      
      expect(detector.check().action).toBe('warn');
    });

    it('should handle very long results', () => {
      const detector = createLoopDetector(10);
      const longResult = 'x'.repeat(10000);
      
      // Same tool returning long result twice
      detector.recordCall('myTool', { a: 1 }, longResult);
      detector.recordCall('myTool', { b: 2 }, longResult);
      
      expect(detector.check().action).toBe('warn');
    });

    it('should handle null and undefined in args', () => {
      const detector = createLoopDetector(10);
      const args = { 
        nullValue: null, 
        undefinedValue: undefined,
        nested: { value: null }
      };
      
      for (let i = 0; i < 3; i++) {
        detector.recordCall('tool', args, 'result');
      }
      
      expect(detector.check().action).toBe('warn');
    });

    it('should handle arrays in args', () => {
      const detector = createLoopDetector(10);
      
      for (let i = 0; i < 3; i++) {
        detector.recordCall('tool', { items: [1, 2, 3] }, 'result');
      }
      
      expect(detector.check().action).toBe('warn');
    });
  });

  describe('Integration scenarios', () => {
    it('should handle realistic agent loop scenario', () => {
      const detector = createLoopDetector(10);
      
      // Agent searches, gets results, searches again with refined query
      detector.recordCall('web_search', { query: 'error message' }, 'results about errors');
      detector.recordCall('file_read', { path: 'logs.txt' }, 'log contents');
      detector.recordCall('web_search', { query: 'error message specific' }, 'more specific results');
      
      expect(detector.check().action).toBe('continue');
    });

    it('should detect stuck agent repeating same search', () => {
      const detector = createLoopDetector(10);
      
      // Agent stuck in loop calling same search
      for (let i = 0; i < 3; i++) {
        detector.recordCall('web_search', { query: 'same query' }, 'same results');
      }
      
      expect(detector.check().action).toBe('warn');
    });

    it('should detect agent making no progress despite different tools', () => {
      const detector = createLoopDetector(10);
      
      // Different tools, same error result
      detector.recordCall('file_read', { path: 'a.txt' }, 'Error: file not found');
      detector.recordCall('file_read', { path: 'b.txt' }, 'Error: file not found');
      
      expect(detector.check().action).toBe('warn');
    });
  });
});

import { describe, expect, it } from 'bun:test';
import { type LoopDetectionResult, ToolLoopDetector } from '../../src/bot/tool-loop-detector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulate N identical tool calls (recordCall + recordOutcome) in sequence.
 */
function simulateCalls(
  detector: ToolLoopDetector,
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  count: number
): void {
  for (let i = 0; i < count; i++) {
    detector.recordCall(toolName, args);
    detector.recordOutcome(toolName, args, result);
  }
}

/**
 * Simulate alternating A-B-A-B calls for ping-pong testing.
 */
function simulateAlternating(
  detector: ToolLoopDetector,
  toolA: string,
  argsA: Record<string, unknown>,
  resultA: string,
  toolB: string,
  argsB: Record<string, unknown>,
  resultB: string,
  pairs: number
): void {
  for (let i = 0; i < pairs; i++) {
    detector.recordCall(toolA, argsA);
    detector.recordOutcome(toolA, argsA, resultA);
    detector.recordCall(toolB, argsB);
    detector.recordOutcome(toolB, argsB, resultB);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolLoopDetector', () => {
  // =========================================================================
  // Construction and defaults
  // =========================================================================
  describe('Construction and defaults', () => {
    it('creates with default config', () => {
      const d = new ToolLoopDetector();
      const cfg = d.getConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.historySize).toBe(30);
      expect(cfg.warningThreshold).toBe(8);
      expect(cfg.criticalThreshold).toBe(16);
      expect(cfg.globalCircuitBreakerThreshold).toBe(25);
      expect(cfg.detectors.genericRepeat).toBe(true);
      expect(cfg.detectors.knownPollNoProgress).toBe(true);
      expect(cfg.detectors.pingPong).toBe(true);
      expect(cfg.knownPollTools).toEqual([
        { toolName: 'process', actions: ['poll', 'log', 'list'] },
      ]);
    });

    it('respects custom thresholds', () => {
      const d = new ToolLoopDetector({
        historySize: 50,
        warningThreshold: 4,
        criticalThreshold: 10,
        globalCircuitBreakerThreshold: 20,
      });
      const cfg = d.getConfig();
      expect(cfg.historySize).toBe(50);
      expect(cfg.warningThreshold).toBe(4);
      expect(cfg.criticalThreshold).toBe(10);
      expect(cfg.globalCircuitBreakerThreshold).toBe(20);
    });

    it('enforces ordering: critical > warning, breaker > critical', () => {
      // critical <= warning should be bumped to warning + 1
      const d1 = new ToolLoopDetector({
        warningThreshold: 10,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 3,
      });
      const c1 = d1.getConfig();
      expect(c1.warningThreshold).toBe(10);
      expect(c1.criticalThreshold).toBeGreaterThan(c1.warningThreshold);
      expect(c1.globalCircuitBreakerThreshold).toBeGreaterThan(c1.criticalThreshold);

      // breaker <= critical should be bumped to critical + 1
      const d2 = new ToolLoopDetector({
        warningThreshold: 5,
        criticalThreshold: 10,
        globalCircuitBreakerThreshold: 8,
      });
      const c2 = d2.getConfig();
      expect(c2.criticalThreshold).toBe(10);
      expect(c2.globalCircuitBreakerThreshold).toBeGreaterThan(c2.criticalThreshold);
    });

    it('uses fallback for invalid (non-positive, non-integer) values', () => {
      const d = new ToolLoopDetector({
        historySize: -5,
        warningThreshold: 0,
        criticalThreshold: 3.7,
        globalCircuitBreakerThreshold: Number.NaN,
      });
      const cfg = d.getConfig();
      // All invalid values should fall back to defaults
      expect(cfg.historySize).toBe(30);
      expect(cfg.warningThreshold).toBe(8);
      expect(cfg.criticalThreshold).toBe(16);
      expect(cfg.globalCircuitBreakerThreshold).toBe(25);
    });
  });

  // =========================================================================
  // Global circuit breaker
  // =========================================================================
  describe('Global circuit breaker', () => {
    it('blocks at globalCircuitBreakerThreshold with critical level', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 7,
        historySize: 50,
        // Disable other detectors so they don't interfere
        detectors: { genericRepeat: false, knownPollNoProgress: false, pingPong: false },
      });
      simulateCalls(d, 'someTool', { x: 1 }, 'same-result', 7);

      const result = d.check('someTool', { x: 1 });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe('critical');
        expect(result.detector).toBe('global_circuit_breaker');
        expect(result.count).toBeGreaterThanOrEqual(7);
      }
    });

    it('allows up to threshold - 1', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 7,
        historySize: 50,
        detectors: { genericRepeat: false, knownPollNoProgress: false, pingPong: false },
      });
      simulateCalls(d, 'someTool', { x: 1 }, 'same-result', 6);

      const result = d.check('someTool', { x: 1 });
      // Should not be blocked by global circuit breaker yet
      // (other detectors disabled, so stuck should be false)
      expect(result.stuck).toBe(false);
    });

    it('returns detector: global_circuit_breaker', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 2,
        criticalThreshold: 4,
        globalCircuitBreakerThreshold: 6,
        historySize: 50,
        detectors: { genericRepeat: false, knownPollNoProgress: false, pingPong: false },
      });
      simulateCalls(d, 'myTool', { a: 1 }, 'static', 6);

      const result = d.check('myTool', { a: 1 });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.detector).toBe('global_circuit_breaker');
      }
    });
  });

  // =========================================================================
  // Known poll no-progress
  // =========================================================================
  describe('Known poll no-progress', () => {
    it('warns at warningThreshold for configured poll tools', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 10,
        historySize: 50,
        knownPollTools: [{ toolName: 'process', actions: ['poll'] }],
      });
      simulateCalls(d, 'process', { action: 'poll' }, 'running...', 3);

      const result = d.check('process', { action: 'poll' });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe('warning');
        expect(result.detector).toBe('known_poll_no_progress');
        expect(result.count).toBeGreaterThanOrEqual(3);
      }
    });

    it('blocks at criticalThreshold for poll tools', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 10,
        historySize: 50,
        knownPollTools: [{ toolName: 'process', actions: ['poll'] }],
      });
      simulateCalls(d, 'process', { action: 'poll' }, 'running...', 6);

      const result = d.check('process', { action: 'poll' });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe('critical');
        expect(result.detector).toBe('known_poll_no_progress');
      }
    });

    it('ignores tools not in knownPollTools list', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 10,
        historySize: 50,
        knownPollTools: [{ toolName: 'process', actions: ['poll'] }],
        // Disable generic repeat so only poll detector is relevant
        detectors: { genericRepeat: false, pingPong: false },
      });
      simulateCalls(d, 'unknownTool', { action: 'poll' }, 'same', 3);

      const result = d.check('unknownTool', { action: 'poll' });
      expect(result.stuck).toBe(false);
    });

    it('respects custom knownPollTools config', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 10,
        historySize: 50,
        knownPollTools: [{ toolName: 'myPoller' }],
        detectors: { genericRepeat: false, pingPong: false },
      });
      // Tool with no actions constraint matches any action
      simulateCalls(d, 'myPoller', { anything: 'goes' }, 'same-result', 3);

      const result = d.check('myPoller', { anything: 'goes' });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.detector).toBe('known_poll_no_progress');
      }
    });

    it('matches action-based poll tools only when action matches', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 10,
        historySize: 50,
        knownPollTools: [{ toolName: 'process', actions: ['poll', 'log'] }],
        detectors: { genericRepeat: false, pingPong: false },
      });

      // action: 'poll' should be detected as poll tool
      simulateCalls(d, 'process', { action: 'poll' }, 'same', 3);
      const resultPoll = d.check('process', { action: 'poll' });
      expect(resultPoll.stuck).toBe(true);
      if (resultPoll.stuck) {
        expect(resultPoll.detector).toBe('known_poll_no_progress');
      }

      d.reset();

      // action: 'execute' should NOT be detected as poll tool
      simulateCalls(d, 'process', { action: 'execute' }, 'same', 3);
      const resultExec = d.check('process', { action: 'execute' });
      // Not a known poll tool with action 'execute', and genericRepeat is disabled
      expect(resultExec.stuck).toBe(false);
    });
  });

  // =========================================================================
  // Ping-pong detector
  // =========================================================================
  describe('Ping-pong detector', () => {
    it('detects A-B-A-B alternation at warning threshold', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 4,
        criticalThreshold: 8,
        globalCircuitBreakerThreshold: 20,
        historySize: 50,
        detectors: { genericRepeat: false, knownPollNoProgress: false, pingPong: true },
      });

      // Build A-B-A-B pattern (4 entries in history)
      simulateAlternating(
        d,
        'toolA',
        { cmd: 'a' },
        'resultA',
        'toolB',
        { cmd: 'b' },
        'resultB',
        2 // 2 pairs = 4 calls: A, B, A, B
      );

      // check() with toolA continues the alternation: A, B, A, B, [A]
      const result = d.check('toolA', { cmd: 'a' });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe('warning');
        expect(result.detector).toBe('ping_pong');
        expect(result.count).toBeGreaterThanOrEqual(4);
      }
    });

    it('requires noProgressEvidence for critical', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 4,
        criticalThreshold: 8,
        globalCircuitBreakerThreshold: 30,
        historySize: 50,
        detectors: { genericRepeat: false, knownPollNoProgress: false, pingPong: true },
      });

      // Build 8 alternating calls with SAME results (no progress)
      simulateAlternating(
        d,
        'toolA',
        { cmd: 'a' },
        'resultA',
        'toolB',
        { cmd: 'b' },
        'resultB',
        4 // 4 pairs = 8 calls
      );

      // Next call continues the alternation: should be critical with noProgressEvidence
      const result = d.check('toolA', { cmd: 'a' });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe('critical');
        expect(result.detector).toBe('ping_pong');
      }
    });

    it('does not trigger for < threshold alternations', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 6,
        criticalThreshold: 12,
        globalCircuitBreakerThreshold: 30,
        historySize: 50,
        detectors: { genericRepeat: false, knownPollNoProgress: false, pingPong: true },
      });

      // Only 2 alternating calls (1 pair) - well under threshold of 6
      simulateAlternating(d, 'toolA', { cmd: 'a' }, 'resultA', 'toolB', { cmd: 'b' }, 'resultB', 1);

      const result = d.check('toolA', { cmd: 'a' });
      expect(result.stuck).toBe(false);
    });

    it('reports correct count', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 4,
        criticalThreshold: 10,
        globalCircuitBreakerThreshold: 30,
        historySize: 50,
        detectors: { genericRepeat: false, knownPollNoProgress: false, pingPong: true },
      });

      // 3 pairs = 6 calls in history: A,B,A,B,A,B
      simulateAlternating(d, 'toolA', { cmd: 'a' }, 'resultA', 'toolB', { cmd: 'b' }, 'resultB', 3);

      // check with toolA -> the alternating count + 1 for the "upcoming" call
      const result = d.check('toolA', { cmd: 'a' });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        // History is A,B,A,B,A,B and we're checking A -> count should be 7
        expect(result.count).toBe(7);
      }
    });
  });

  // =========================================================================
  // Generic repeat
  // =========================================================================
  describe('Generic repeat', () => {
    it('warns for repeated same tool+args at warningThreshold', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 4,
        criticalThreshold: 8,
        globalCircuitBreakerThreshold: 15,
        historySize: 50,
        detectors: { genericRepeat: true, knownPollNoProgress: false, pingPong: false },
      });
      simulateCalls(d, 'search', { q: 'test' }, 'same-result', 4);

      const result = d.check('search', { q: 'test' });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe('warning');
        expect(result.detector).toBe('generic_repeat');
        expect(result.count).toBeGreaterThanOrEqual(4);
      }
    });

    it('Fix #3: does NOT warn when results differ across calls', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 4,
        criticalThreshold: 8,
        globalCircuitBreakerThreshold: 15,
        historySize: 50,
        detectors: { genericRepeat: true, knownPollNoProgress: false, pingPong: false },
      });

      // Same tool+args but DIFFERENT results each time
      for (let i = 0; i < 5; i++) {
        d.recordCall('search', { q: 'test' });
        d.recordOutcome('search', { q: 'test' }, `different-result-${i}`);
      }

      const result = d.check('search', { q: 'test' });
      // Results are changing, so the detector should NOT fire
      expect(result.stuck).toBe(false);
    });

    it('still warns when all results are identical', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 4,
        criticalThreshold: 8,
        globalCircuitBreakerThreshold: 15,
        historySize: 50,
        detectors: { genericRepeat: true, knownPollNoProgress: false, pingPong: false },
      });
      simulateCalls(d, 'search', { q: 'test' }, 'always-same', 4);

      const result = d.check('search', { q: 'test' });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.detector).toBe('generic_repeat');
      }
    });

    it('does not fire for known poll tools (defers to poll detector)', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 15,
        historySize: 50,
        knownPollTools: [{ toolName: 'process', actions: ['poll'] }],
        detectors: { genericRepeat: true, knownPollNoProgress: false, pingPong: false },
      });
      simulateCalls(d, 'process', { action: 'poll' }, 'same', 4);

      const result = d.check('process', { action: 'poll' });
      // genericRepeat skips known poll tools, and knownPollNoProgress is disabled
      expect(result.stuck).toBe(false);
    });
  });

  // =========================================================================
  // Fix #1: getNoProgressStreak consecutive counting
  // =========================================================================
  describe('Fix #1: getNoProgressStreak consecutive counting', () => {
    it('A A B A A -> streak 2 not 4 (breaks on non-matching B)', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 10,
        historySize: 50,
        detectors: { genericRepeat: false, knownPollNoProgress: false, pingPong: false },
      });

      // A, A, B, A, A
      simulateCalls(d, 'toolA', { x: 1 }, 'same', 2);
      simulateCalls(d, 'toolB', { x: 2 }, 'other', 1);
      simulateCalls(d, 'toolA', { x: 1 }, 'same', 2);

      // The consecutive streak from the tail for toolA should be 2 (not 4)
      // because B in the middle breaks it. With threshold 3, should NOT trigger breaker.
      const result = d.check('toolA', { x: 1 });
      expect(result.stuck).toBe(false);
    });

    it('A A A -> streak 3', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 10,
        historySize: 50,
        // Only global circuit breaker uses getNoProgressStreak directly
        // Enable poll detector to verify streak count via poll tool
        knownPollTools: [{ toolName: 'toolA' }],
        detectors: { genericRepeat: false, knownPollNoProgress: true, pingPong: false },
      });

      simulateCalls(d, 'toolA', { x: 1 }, 'same', 3);

      const result = d.check('toolA', { x: 1 });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.count).toBe(3);
      }
    });
  });

  // =========================================================================
  // Fix #2: warnedPatterns cleanup
  // =========================================================================
  describe('Fix #2: warnedPatterns cleanup', () => {
    it('warned pattern clears after sliding window shifts past it', () => {
      // Use small history so patterns slide out quickly
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 15,
        historySize: 5,
        detectors: { genericRepeat: true, knownPollNoProgress: false, pingPong: false },
      });

      // Fill with 3 identical calls -> triggers warning
      simulateCalls(d, 'toolX', { a: 1 }, 'same', 3);
      const warn1 = d.check('toolX', { a: 1 });
      expect(warn1.stuck).toBe(true);

      // Now push different calls to shift toolX out of the 5-entry window
      for (let i = 0; i < 5; i++) {
        d.recordCall('otherTool', { i });
        d.recordOutcome('otherTool', { i }, `result-${i}`);
      }

      // Now re-add toolX calls — should warn AGAIN since the pattern left the window
      simulateCalls(d, 'toolX', { a: 1 }, 'same', 3);
      const warn2 = d.check('toolX', { a: 1 });
      expect(warn2.stuck).toBe(true);
      if (warn2.stuck) {
        expect(warn2.detector).toBe('generic_repeat');
      }
    });

    it('does NOT re-warn for same pattern within window', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 10,
        globalCircuitBreakerThreshold: 20,
        historySize: 50,
        detectors: { genericRepeat: true, knownPollNoProgress: false, pingPong: false },
      });

      simulateCalls(d, 'toolY', { b: 2 }, 'same', 3);
      const warn1 = d.check('toolY', { b: 2 });
      expect(warn1.stuck).toBe(true);

      // Add one more call but pattern is still in window
      simulateCalls(d, 'toolY', { b: 2 }, 'same', 1);
      const warn2 = d.check('toolY', { b: 2 });
      // Already warned for this pattern in the current window, should not re-warn
      expect(warn2.stuck).toBe(false);
    });

    it('re-warns after pattern exits and re-enters window', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 2,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 10,
        historySize: 4,
        detectors: { genericRepeat: true, knownPollNoProgress: false, pingPong: false },
      });

      // 2 calls triggers warning
      simulateCalls(d, 'myTool', { k: 1 }, 'same', 2);
      const first = d.check('myTool', { k: 1 });
      expect(first.stuck).toBe(true);

      // Push pattern out of window (historySize=4, so 4 new calls evicts old ones)
      for (let i = 0; i < 4; i++) {
        d.recordCall('filler', { i });
        d.recordOutcome('filler', { i }, `fill-${i}`);
      }

      // Re-enter same pattern
      simulateCalls(d, 'myTool', { k: 1 }, 'same', 2);
      const second = d.check('myTool', { k: 1 });
      expect(second.stuck).toBe(true);
      if (second.stuck) {
        expect(second.detector).toBe('generic_repeat');
      }
    });
  });

  // =========================================================================
  // recordCall and recordOutcome lifecycle
  // =========================================================================
  describe('recordCall and recordOutcome lifecycle', () => {
    it('recordCall adds entry without resultHash', () => {
      const d = new ToolLoopDetector();
      d.recordCall('tool1', { a: 1 });

      const stats = d.getStats();
      expect(stats.totalCalls).toBe(1);
      expect(stats.uniquePatterns).toBe(1);
    });

    it('recordOutcome patches matching entry with resultHash', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 2,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 10,
        historySize: 50,
        knownPollTools: [{ toolName: 'pollTool' }],
      });

      // Record 2 calls with outcomes for a poll tool
      d.recordCall('pollTool', { x: 1 });
      d.recordOutcome('pollTool', { x: 1 }, 'same-result');
      d.recordCall('pollTool', { x: 1 });
      d.recordOutcome('pollTool', { x: 1 }, 'same-result');

      // The streak detection relies on resultHash being set
      // If recordOutcome didn't patch, streak would be 0
      const result = d.check('pollTool', { x: 1 });
      expect(result.stuck).toBe(true);
    });

    it('maintains sliding window size (trims oldest)', () => {
      const d = new ToolLoopDetector({ historySize: 5 });

      // Add 8 calls
      for (let i = 0; i < 8; i++) {
        d.recordCall('tool', { i });
      }

      const stats = d.getStats();
      expect(stats.totalCalls).toBe(5);
    });

    it('recordOutcome on unknown entry is a no-op', () => {
      const d = new ToolLoopDetector();

      // No prior recordCall for this tool
      d.recordOutcome('neverCalled', { a: 1 }, 'result');

      const stats = d.getStats();
      expect(stats.totalCalls).toBe(0);
    });
  });

  // =========================================================================
  // Disabled detector
  // =========================================================================
  describe('Disabled detector', () => {
    it('check() returns stuck:false when enabled:false', () => {
      const d = new ToolLoopDetector({ enabled: false });

      // Even with many repeated calls, check should return not stuck
      simulateCalls(d, 'tool', { x: 1 }, 'same', 100);
      const result = d.check('tool', { x: 1 });
      expect(result.stuck).toBe(false);
    });

    it('recordCall is no-op when enabled:false', () => {
      const d = new ToolLoopDetector({ enabled: false });

      d.recordCall('tool', { x: 1 });
      d.recordCall('tool', { x: 1 });

      const stats = d.getStats();
      expect(stats.totalCalls).toBe(0);
    });
  });

  // =========================================================================
  // reset()
  // =========================================================================
  describe('reset()', () => {
    it('clears all history and warned patterns', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 15,
        historySize: 50,
      });

      simulateCalls(d, 'tool', { a: 1 }, 'same', 5);
      expect(d.getStats().totalCalls).toBe(5);

      d.reset();
      expect(d.getStats().totalCalls).toBe(0);
      expect(d.getStats().uniquePatterns).toBe(0);
      expect(d.getStats().mostFrequent).toBeNull();
    });

    it('getStats shows 0 after reset', () => {
      const d = new ToolLoopDetector();
      simulateCalls(d, 'a', {}, 'r', 10);
      d.reset();

      const stats = d.getStats();
      expect(stats.totalCalls).toBe(0);
      expect(stats.uniquePatterns).toBe(0);
      expect(stats.mostFrequent).toBeNull();
    });
  });

  // =========================================================================
  // getStats()
  // =========================================================================
  describe('getStats()', () => {
    it('returns correct totalCalls', () => {
      const d = new ToolLoopDetector({ historySize: 50 });
      simulateCalls(d, 'toolA', { x: 1 }, 'r1', 3);
      simulateCalls(d, 'toolB', { x: 2 }, 'r2', 2);

      expect(d.getStats().totalCalls).toBe(5);
    });

    it('returns correct uniquePatterns', () => {
      const d = new ToolLoopDetector({ historySize: 50 });
      simulateCalls(d, 'toolA', { x: 1 }, 'r1', 3);
      simulateCalls(d, 'toolB', { x: 2 }, 'r2', 2);
      simulateCalls(d, 'toolA', { x: 1 }, 'r1', 1); // same pattern as first

      expect(d.getStats().uniquePatterns).toBe(2);
    });

    it('identifies mostFrequent tool', () => {
      const d = new ToolLoopDetector({ historySize: 50 });
      simulateCalls(d, 'rare', { x: 1 }, 'r1', 1);
      simulateCalls(d, 'frequent', { x: 2 }, 'r2', 5);
      simulateCalls(d, 'medium', { x: 3 }, 'r3', 3);

      const stats = d.getStats();
      expect(stats.mostFrequent).not.toBeNull();
      expect(stats.mostFrequent!.toolName).toBe('frequent');
      expect(stats.mostFrequent!.count).toBe(5);
    });

    it('returns null for mostFrequent when empty', () => {
      const d = new ToolLoopDetector();
      expect(d.getStats().mostFrequent).toBeNull();
    });
  });

  // =========================================================================
  // Detector priority
  // =========================================================================
  describe('Detector priority', () => {
    it('global circuit breaker takes priority over poll detector', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 7,
        historySize: 50,
        knownPollTools: [{ toolName: 'process', actions: ['poll'] }],
      });

      // Enough calls to trigger both global breaker AND poll critical
      simulateCalls(d, 'process', { action: 'poll' }, 'stuck', 7);

      const result = d.check('process', { action: 'poll' });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.detector).toBe('global_circuit_breaker');
      }
    });

    it('poll detector takes priority over ping-pong', () => {
      // This tests that when a tool is both a known poll tool and part of a
      // ping-pong pattern, the poll detector fires first.
      const d = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 20,
        historySize: 50,
        knownPollTools: [{ toolName: 'process', actions: ['poll'] }],
      });

      // Build up a streak of poll calls that reaches warning threshold
      simulateCalls(d, 'process', { action: 'poll' }, 'same-result', 3);

      const result = d.check('process', { action: 'poll' });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.detector).toBe('known_poll_no_progress');
      }
    });

    it('ping-pong takes priority over generic repeat', () => {
      const d = new ToolLoopDetector({
        warningThreshold: 4,
        criticalThreshold: 10,
        globalCircuitBreakerThreshold: 30,
        historySize: 50,
        // Both detectors enabled
        detectors: { genericRepeat: true, knownPollNoProgress: false, pingPong: true },
      });

      // Build A-B-A-B pattern that reaches warning threshold
      simulateAlternating(
        d,
        'toolA',
        { x: 1 },
        'resultA',
        'toolB',
        { x: 2 },
        'resultB',
        2 // 4 calls: A, B, A, B
      );

      // check with toolA to continue the pattern (count becomes 5)
      const result = d.check('toolA', { x: 1 });
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        // ping-pong should fire before generic_repeat
        expect(result.detector).toBe('ping_pong');
      }
    });
  });
});

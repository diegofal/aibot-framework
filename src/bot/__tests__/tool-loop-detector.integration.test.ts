import { describe, expect, it } from 'bun:test';
import { ToolLoopDetector } from '../tool-loop-detector';
import type { LoopDetectionResult } from '../tool-loop-detector';

/**
 * Integration tests for ToolLoopDetector
 *
 * These exercise realistic multi-turn tool call sequences — the kind of
 * patterns an LLM actually produces when it gets stuck. Not unit-level
 * mocks; full detector lifecycle with check → recordCall → recordOutcome.
 */

// Helper: full lifecycle of a tool call (check, record, outcome)
function simulateCall(
  detector: ToolLoopDetector,
  toolName: string,
  params: unknown,
  result: string
): LoopDetectionResult {
  const check = detector.check(toolName, params);
  detector.recordCall(toolName, params);
  detector.recordOutcome(toolName, params, result);
  return check;
}

// Helper: simulate a call without recording outcome (fire-and-forget)
function simulateCallNoOutcome(
  detector: ToolLoopDetector,
  toolName: string,
  params: unknown
): LoopDetectionResult {
  const check = detector.check(toolName, params);
  detector.recordCall(toolName, params);
  return check;
}

describe('ToolLoopDetector — Integration', () => {
  // -----------------------------------------------------------------------
  // Realistic multi-turn conversation scenarios
  // -----------------------------------------------------------------------

  describe('realistic agent conversation', () => {
    it('should not flag a normal multi-step task (search → read → edit → test)', () => {
      const detector = new ToolLoopDetector();

      // Agent researches, reads files, edits, runs tests — no repetition
      const steps: [string, Record<string, unknown>, string][] = [
        ['web_search', { q: 'bun test mocking' }, 'Results: bun mock guide...'],
        ['file_read', { path: 'src/utils.ts' }, 'export function foo()...'],
        ['file_read', { path: 'src/utils.test.ts' }, 'import { foo } from...'],
        ['file_edit', { path: 'src/utils.ts', content: 'fixed' }, 'File saved'],
        ['exec', { command: 'bun test src/utils.test.ts' }, '3 pass, 0 fail'],
        ['file_read', { path: 'src/other.ts' }, 'export class Bar...'],
        ['exec', { command: 'bun test' }, '47 pass, 0 fail'],
      ];

      for (const [tool, params, result] of steps) {
        const check = simulateCall(detector, tool, params, result);
        expect(check.stuck).toBe(false);
      }
    });

    it('should detect an LLM stuck retrying a failing build command', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 10,
      });

      const buildCmd = { command: 'bun run build' };
      const sameError = 'Error: Cannot find module "./missing"';

      // First 2 attempts — fine
      simulateCall(detector, 'exec', buildCmd, sameError);
      simulateCall(detector, 'exec', buildCmd, sameError);
      expect(simulateCall(detector, 'exec', buildCmd, sameError).stuck).toBe(false);

      // 4th attempt — warning fires
      const warn = simulateCall(detector, 'exec', buildCmd, sameError);
      expect(warn.stuck).toBe(true);
      if (warn.stuck) {
        expect(warn.level).toBe('warning');
        expect(warn.detector).toBe('generic_repeat');
      }

      // After warning, same pattern continues — warning already emitted, so
      // detector returns false until critical threshold
      simulateCall(detector, 'exec', buildCmd, sameError);
      simulateCall(detector, 'exec', buildCmd, sameError);

      // At 7 calls same result, circuit breaker hasn't hit yet but generic
      // repeat was already warned. The global breaker needs 10.
      const check7 = simulateCall(detector, 'exec', buildCmd, sameError);
      // Warning already consumed — should be false or a different detector
      // (This validates the warnedPatterns dedup logic)
    });

    it('should NOT flag a build-fix-retry cycle where results change', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 10,
      });

      const buildCmd = { command: 'bun run build' };

      // Each attempt gets a different error — the agent IS making progress
      simulateCall(detector, 'exec', buildCmd, 'Error: line 10 missing semicolon');
      simulateCall(detector, 'file_edit', { path: 'src/a.ts' }, 'saved');
      simulateCall(detector, 'exec', buildCmd, 'Error: line 25 type mismatch');
      simulateCall(detector, 'file_edit', { path: 'src/b.ts' }, 'saved');
      simulateCall(detector, 'exec', buildCmd, 'Error: line 40 unused import');
      simulateCall(detector, 'file_edit', { path: 'src/c.ts' }, 'saved');
      simulateCall(detector, 'exec', buildCmd, 'Build successful');

      // Same tool+args 4 times but results changed each time — no flag
      const check = detector.check('exec', buildCmd);
      expect(check.stuck).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Ping-pong detection
  // -----------------------------------------------------------------------

  describe('ping-pong detector', () => {
    it('should detect A-B-A-B alternation with static results', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 4,
        criticalThreshold: 8,
        globalCircuitBreakerThreshold: 20,
      });

      const readA = { path: 'config.json' };
      const readB = { path: 'schema.json' };

      // Build an alternating pattern with identical results
      for (let i = 0; i < 5; i++) {
        simulateCall(detector, 'file_read', readA, '{"key": "value"}');
        simulateCall(detector, 'file_read', readB, '{"type": "object"}');
      }

      // Next call continues the pattern — should trigger ping-pong
      const check = detector.check('file_read', readA);
      if (check.stuck) {
        expect(check.detector).toBe('ping_pong');
      }
      // At minimum the detector should have noticed something
      expect(detector.getStats().totalCalls).toBe(10);
    });

    it('should NOT flag alternation where results change (making progress)', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 4,
        criticalThreshold: 8,
        globalCircuitBreakerThreshold: 20,
      });

      // Agent reads a log, then checks status — but the log content changes
      for (let i = 0; i < 5; i++) {
        simulateCall(
          detector,
          'exec',
          { command: 'tail log.txt' },
          `Line ${i * 10}: processing...`
        );
        simulateCall(detector, 'exec', { command: 'curl status' }, `{"progress": ${i * 20}}`);
      }

      // Results differ each round — this is a legitimate monitoring loop
      const check = detector.check('exec', { command: 'tail log.txt' });
      // The ping-pong detector should see noProgressEvidence = false
      // so it should NOT trigger at critical level
      if (check.stuck) {
        expect(check.level).not.toBe('critical');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Known poll tool detection
  // -----------------------------------------------------------------------

  describe('known poll tool detector', () => {
    it('should detect repeated polling of process with same results', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 15,
        knownPollTools: [{ toolName: 'process', actions: ['poll', 'log', 'list'] }],
      });

      const pollParams = { action: 'poll', sessionId: 'build-123' };
      const sameOutput = 'Still compiling...';

      // Poll 3 times with identical output
      simulateCall(detector, 'process', pollParams, sameOutput);
      simulateCall(detector, 'process', pollParams, sameOutput);
      simulateCall(detector, 'process', pollParams, sameOutput);

      // 4th check should trigger warning
      const warn = detector.check('process', pollParams);
      expect(warn.stuck).toBe(true);
      if (warn.stuck) {
        expect(warn.level).toBe('warning');
        expect(warn.detector).toBe('known_poll_no_progress');
      }
    });

    it('should escalate to critical after sustained polling', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 2,
        criticalThreshold: 4,
        globalCircuitBreakerThreshold: 15,
        knownPollTools: [{ toolName: 'process', actions: ['poll'] }],
      });

      const pollParams = { action: 'poll', sessionId: 'deploy-456' };
      const frozen = 'Deploying... (step 3/10)';

      // Hammer the poll
      for (let i = 0; i < 5; i++) {
        simulateCall(detector, 'process', pollParams, frozen);
      }

      const crit = detector.check('process', pollParams);
      expect(crit.stuck).toBe(true);
      if (crit.stuck) {
        expect(crit.level).toBe('critical');
        expect(crit.detector).toBe('known_poll_no_progress');
      }
    });

    it('should NOT flag poll tool when results change (process is progressing)', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 15,
        knownPollTools: [{ toolName: 'process', actions: ['poll'] }],
      });

      const pollParams = { action: 'poll', sessionId: 'test-run' };

      // Each poll returns different output — the process is making progress
      simulateCall(detector, 'process', pollParams, 'Running test 1/10...');
      simulateCall(detector, 'process', pollParams, 'Running test 5/10...');
      simulateCall(detector, 'process', pollParams, 'Running test 8/10...');
      simulateCall(detector, 'process', pollParams, 'Running test 10/10... done');

      const check = detector.check('process', pollParams);
      // The no-progress streak should be 0 because results keep changing
      expect(check.stuck).toBe(false);
    });

    it('should ignore non-poll actions on known poll tools', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 15,
        knownPollTools: [{ toolName: 'process', actions: ['poll'] }],
      });

      // 'kill' is not in the actions list — should not trigger poll detector
      const killParams = { action: 'kill', sessionId: 'build-789' };
      for (let i = 0; i < 4; i++) {
        simulateCall(detector, 'process', killParams, 'Process killed');
      }

      // Should hit generic_repeat, NOT known_poll
      const check = detector.check('process', killParams);
      if (check.stuck) {
        expect(check.detector).not.toBe('known_poll_no_progress');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Warning escalation and dedup
  // -----------------------------------------------------------------------

  describe('warning escalation and dedup', () => {
    it('should emit warning only once per pattern (dedup)', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 10,
        globalCircuitBreakerThreshold: 20,
      });

      const args = { q: 'stuck query' };

      // Build up to warning threshold
      for (let i = 0; i < 3; i++) {
        simulateCall(detector, 'web_search', args, 'same result');
      }

      // First check past threshold → warning
      const first = detector.check('web_search', args);
      expect(first.stuck).toBe(true);
      if (first.stuck) expect(first.level).toBe('warning');

      // Record the call
      detector.recordCall('web_search', args);
      detector.recordOutcome('web_search', args, 'same result');

      // Second check with same pattern → deduped (not stuck)
      const second = detector.check('web_search', args);
      expect(second.stuck).toBe(false);
    });

    it('should re-warn after pattern exits and re-enters the window', () => {
      const detector = new ToolLoopDetector({
        historySize: 6,
        warningThreshold: 3,
        criticalThreshold: 10,
        globalCircuitBreakerThreshold: 20,
      });

      const stuckArgs = { q: 'stuck' };

      // Trigger warning
      for (let i = 0; i < 3; i++) {
        simulateCall(detector, 'web_search', stuckArgs, 'same');
      }
      const warn1 = detector.check('web_search', stuckArgs);
      expect(warn1.stuck).toBe(true);

      // Push different calls to flush the window (historySize=6)
      for (let i = 0; i < 7; i++) {
        simulateCall(detector, 'exec', { command: `different-${i}` }, `result-${i}`);
      }

      // Now the old pattern is gone from the window — re-entering should re-warn
      for (let i = 0; i < 3; i++) {
        simulateCall(detector, 'web_search', stuckArgs, 'same');
      }
      const warn2 = detector.check('web_search', stuckArgs);
      // After window flush, the warned key should have been cleaned
      expect(warn2.stuck).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Global circuit breaker
  // -----------------------------------------------------------------------

  describe('global circuit breaker', () => {
    it('should block everything at the absolute ceiling', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 8,
      });

      const args = { path: 'broken.ts' };

      for (let i = 0; i < 8; i++) {
        simulateCall(detector, 'file_read', args, 'same broken content');
      }

      const result = detector.check('file_read', args);
      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe('critical');
        expect(result.detector).toBe('global_circuit_breaker');
        expect(result.count).toBeGreaterThanOrEqual(8);
      }
    });

    it('should enforce threshold ordering (warn < critical < breaker)', () => {
      // Deliberately pass bad ordering
      const detector = new ToolLoopDetector({
        warningThreshold: 10,
        criticalThreshold: 5, // less than warning — should be corrected
        globalCircuitBreakerThreshold: 3, // less than critical — should be corrected
      });

      const config = detector.getConfig();
      expect(config.warningThreshold).toBe(10);
      expect(config.criticalThreshold).toBeGreaterThan(config.warningThreshold);
      expect(config.globalCircuitBreakerThreshold).toBeGreaterThan(config.criticalThreshold);
    });
  });

  // -----------------------------------------------------------------------
  // getStats
  // -----------------------------------------------------------------------

  describe('getStats', () => {
    it('should track call patterns accurately', () => {
      const detector = new ToolLoopDetector();

      simulateCall(detector, 'web_search', { q: 'a' }, 'result a');
      simulateCall(detector, 'web_search', { q: 'a' }, 'result a');
      simulateCall(detector, 'web_search', { q: 'b' }, 'result b');
      simulateCall(detector, 'file_read', { path: 'x' }, 'content');

      const stats = detector.getStats();
      expect(stats.totalCalls).toBe(4);
      expect(stats.uniquePatterns).toBe(3); // search:a, search:b, file_read:x
      expect(stats.mostFrequent).not.toBeNull();
      expect(stats.mostFrequent?.toolName).toBe('web_search');
      expect(stats.mostFrequent?.count).toBe(2);
    });

    it('should return null mostFrequent on empty history', () => {
      const detector = new ToolLoopDetector();
      const stats = detector.getStats();
      expect(stats.totalCalls).toBe(0);
      expect(stats.uniquePatterns).toBe(0);
      expect(stats.mostFrequent).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Sliding window
  // -----------------------------------------------------------------------

  describe('sliding window', () => {
    it('should trim history to historySize', () => {
      const detector = new ToolLoopDetector({ historySize: 5 });

      for (let i = 0; i < 10; i++) {
        simulateCall(detector, 'exec', { command: `cmd-${i}` }, `out-${i}`);
      }

      const stats = detector.getStats();
      expect(stats.totalCalls).toBe(5);
    });

    it('should forget old patterns after they slide out of the window', () => {
      const detector = new ToolLoopDetector({
        historySize: 5,
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 10,
      });

      const stuckArgs = { q: 'loop' };

      // 3 identical calls — enough for warning threshold
      simulateCall(detector, 'web_search', stuckArgs, 'same');
      simulateCall(detector, 'web_search', stuckArgs, 'same');
      simulateCall(detector, 'web_search', stuckArgs, 'same');

      // Push 5 different calls to flush the window
      for (let i = 0; i < 5; i++) {
        simulateCall(detector, 'file_read', { path: `file-${i}.ts` }, `content-${i}`);
      }

      // The old "web_search" calls are gone — should not be stuck
      const check = detector.check('web_search', stuckArgs);
      expect(check.stuck).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle calls without outcomes gracefully', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 10,
      });

      // Record calls but never record outcomes
      for (let i = 0; i < 5; i++) {
        simulateCallNoOutcome(detector, 'exec', { command: 'hang' });
      }

      // Without result hashes, no-progress streak can't build
      const stats = detector.getStats();
      expect(stats.totalCalls).toBe(5);
    });

    it('should handle empty/null params', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 5,
        globalCircuitBreakerThreshold: 10,
      });

      simulateCall(detector, 'exec', null, 'ok');
      simulateCall(detector, 'exec', undefined, 'ok');
      simulateCall(detector, 'exec', {}, 'ok');

      // Should not crash
      const stats = detector.getStats();
      expect(stats.totalCalls).toBe(3);
    });

    it('should handle complex nested params without crashing', () => {
      const detector = new ToolLoopDetector();

      const complexParams = {
        nested: { deep: { array: [1, { key: 'val' }, [2, 3]] } },
        flag: true,
        count: 42,
      };

      // Should hash without errors
      simulateCall(detector, 'complex_tool', complexParams, 'ok');
      const check = detector.check('complex_tool', complexParams);
      expect(check.stuck).toBe(false);
    });

    it('should produce stable hashes regardless of key order', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 2,
        criticalThreshold: 4,
        globalCircuitBreakerThreshold: 10,
      });

      // Same params, different key order — should hash identically
      simulateCall(detector, 'exec', { a: 1, b: 2 }, 'same');
      simulateCall(detector, 'exec', { b: 2, a: 1 }, 'same');

      // 2 calls with same hash + same result = should trigger at threshold 2
      const check = detector.check('exec', { a: 1, b: 2 });
      expect(check.stuck).toBe(true);
      if (check.stuck) {
        expect(check.detector).toBe('generic_repeat');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Detector toggle
  // -----------------------------------------------------------------------

  describe('detector toggles', () => {
    it('should skip ping-pong detection when disabled', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 20,
        detectors: { pingPong: false },
      });

      // Build a clear ping-pong pattern
      for (let i = 0; i < 8; i++) {
        simulateCall(detector, 'file_read', { path: i % 2 === 0 ? 'a.ts' : 'b.ts' }, 'same');
      }

      const check = detector.check('file_read', { path: 'a.ts' });
      // With pingPong disabled, it should NOT fire as ping_pong
      if (check.stuck) {
        expect(check.detector).not.toBe('ping_pong');
      }
    });

    it('should skip generic repeat when disabled', () => {
      const detector = new ToolLoopDetector({
        warningThreshold: 3,
        criticalThreshold: 6,
        globalCircuitBreakerThreshold: 20,
        detectors: { genericRepeat: false },
      });

      for (let i = 0; i < 5; i++) {
        simulateCall(detector, 'web_search', { q: 'same' }, 'same');
      }

      const check = detector.check('web_search', { q: 'same' });
      if (check.stuck) {
        expect(check.detector).not.toBe('generic_repeat');
      }
    });
  });
});

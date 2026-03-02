/**
 * Tool Loop Detector for aibot-framework
 *
 * Detects when an LLM is stuck in repetitive tool call patterns and provides
 * warning/blocking signals to break the loop.
 *
 * Adapted from OpenClaw's tool-loop-detection.ts (4 detectors) with
 * architectural changes to fit our ToolExecutor class pattern.
 *
 * 4 detectors:
 *   1. global_circuit_breaker — absolute no-progress ceiling
 *   2. known_poll_no_progress — polling tools returning same results
 *   3. ping_pong — A↔B alternating patterns with no progress
 *   4. generic_repeat — same tool+args repeated (result-aware)
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoopDetectorKind =
  | 'generic_repeat'
  | 'known_poll_no_progress'
  | 'ping_pong'
  | 'global_circuit_breaker';

export type LoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: 'warning' | 'critical';
      detector: LoopDetectorKind;
      count: number;
      message: string;
    };

export interface KnownPollToolEntry {
  toolName: string;
  actions?: string[];
}

export interface LoopDetectorConfig {
  /** Enable loop detection (default: true). */
  enabled?: boolean;
  /** Sliding window size for call history (default: 30). */
  historySize?: number;
  /** Calls before a warning is emitted (default: 8). */
  warningThreshold?: number;
  /** Calls before execution is blocked (default: 16). */
  criticalThreshold?: number;
  /** Absolute no-progress ceiling that blocks everything (default: 25). */
  globalCircuitBreakerThreshold?: number;
  /** Toggle individual detectors. */
  detectors?: {
    genericRepeat?: boolean;
    knownPollNoProgress?: boolean;
    pingPong?: boolean;
  };
  /** Configurable list of tools considered "polling" tools. */
  knownPollTools?: KnownPollToolEntry[];
}

interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  enabled: true,
  historySize: 30,
  warningThreshold: 8,
  criticalThreshold: 16,
  globalCircuitBreakerThreshold: 25,
  detectors: {
    genericRepeat: true,
    knownPollNoProgress: true,
    pingPong: true,
  },
  knownPollTools: [
    { toolName: 'process', actions: ['poll', 'log', 'list'] },
  ] as KnownPollToolEntry[],
} as const;

// ---------------------------------------------------------------------------
// Hashing utilities
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function hashArgs(toolName: string, params: unknown): string {
  try {
    return `${toolName}:${shortHash(stableStringify(params))}`;
  } catch {
    // Fallback for circular references or weird objects
    return `${toolName}:${shortHash(String(params))}`;
  }
}

/** Hash result content, truncating to first 500 chars to avoid expensive hashing on large outputs. */
function hashResult(content: string): string {
  return shortHash(content.slice(0, 500));
}

// ---------------------------------------------------------------------------
// Poll tool detection
// ---------------------------------------------------------------------------

function isKnownPollTool(
  toolName: string,
  params: unknown,
  knownPollTools: KnownPollToolEntry[]
): boolean {
  for (const entry of knownPollTools) {
    if (entry.toolName !== toolName) continue;
    if (!entry.actions || entry.actions.length === 0) return true;
    const action = (params as Record<string, unknown>)?.action;
    if (typeof action === 'string' && entry.actions.includes(action)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Streak calculations
// ---------------------------------------------------------------------------

/**
 * Count consecutive times (from the tail) the same tool+args returned
 * the same result. Breaks on any non-matching entry (true consecutive streak).
 */
function getNoProgressStreak(
  history: ToolCallRecord[],
  toolName: string,
  argsHash: string
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i];
    if (!record) break;

    // Break on any entry that doesn't match our tool+args (Fix #1: consecutive only)
    if (record.toolName !== toolName || record.argsHash !== argsHash) {
      break;
    }

    if (!record.resultHash) {
      break;
    }

    if (!latestResultHash) {
      latestResultHash = record.resultHash;
      streak = 1;
      continue;
    }

    if (record.resultHash !== latestResultHash) {
      break;
    }

    streak++;
  }

  return { count: streak, latestResultHash };
}

/**
 * Detect A-B-A-B alternating patterns in the history tail.
 * Returns the length of the alternating sequence and whether both sides
 * show identical results (no progress).
 */
function getPingPongStreak(
  history: ToolCallRecord[],
  currentArgsHash: string
): { count: number; pairedToolName?: string; noProgressEvidence: boolean } {
  const last = history.at(-1);
  if (!last) return { count: 0, noProgressEvidence: false };

  // Find the "other" signature (first entry that differs from last)
  let otherHash: string | undefined;
  let otherToolName: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    const call = history[i];
    if (call && call.argsHash !== last.argsHash) {
      otherHash = call.argsHash;
      otherToolName = call.toolName;
      break;
    }
  }

  if (!otherHash || !otherToolName) return { count: 0, noProgressEvidence: false };

  // Count how long the alternating tail is
  let alternatingCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const call = history[i];
    if (!call) continue;
    const expected = alternatingCount % 2 === 0 ? last.argsHash : otherHash;
    if (call.argsHash !== expected) break;
    alternatingCount++;
  }

  if (alternatingCount < 2) return { count: 0, noProgressEvidence: false };

  // The current call should continue the pattern
  if (currentArgsHash !== otherHash) return { count: 0, noProgressEvidence: false };

  // Check if results are static on both sides (no progress)
  const tailStart = Math.max(0, history.length - alternatingCount);
  let firstHashA: string | undefined;
  let firstHashB: string | undefined;
  let noProgressEvidence = true;

  for (let i = tailStart; i < history.length; i++) {
    const call = history[i];
    if (!call || !call.resultHash) {
      noProgressEvidence = false;
      break;
    }
    if (call.argsHash === last.argsHash) {
      if (!firstHashA) firstHashA = call.resultHash;
      else if (firstHashA !== call.resultHash) {
        noProgressEvidence = false;
        break;
      }
    } else if (call.argsHash === otherHash) {
      if (!firstHashB) firstHashB = call.resultHash;
      else if (firstHashB !== call.resultHash) {
        noProgressEvidence = false;
        break;
      }
    } else {
      noProgressEvidence = false;
      break;
    }
  }

  // Need stable results on both sides to claim no progress
  if (!firstHashA || !firstHashB) noProgressEvidence = false;

  return {
    count: alternatingCount + 1, // +1 for the current call
    pairedToolName: last.toolName,
    noProgressEvidence,
  };
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class ToolLoopDetector {
  private history: ToolCallRecord[] = [];
  private warnedPatterns = new Set<string>();
  private config: Required<LoopDetectorConfig> & {
    detectors: Required<NonNullable<LoopDetectorConfig['detectors']>>;
    knownPollTools: KnownPollToolEntry[];
  };

  constructor(config?: LoopDetectorConfig) {
    const warn = asPositiveInt(config?.warningThreshold, DEFAULTS.warningThreshold);
    let crit = asPositiveInt(config?.criticalThreshold, DEFAULTS.criticalThreshold);
    let breaker = asPositiveInt(
      config?.globalCircuitBreakerThreshold,
      DEFAULTS.globalCircuitBreakerThreshold
    );

    // Enforce ordering: warning < critical < breaker
    if (crit <= warn) crit = warn + 1;
    if (breaker <= crit) breaker = crit + 1;

    this.config = {
      enabled: config?.enabled ?? DEFAULTS.enabled,
      historySize: asPositiveInt(config?.historySize, DEFAULTS.historySize),
      warningThreshold: warn,
      criticalThreshold: crit,
      globalCircuitBreakerThreshold: breaker,
      detectors: {
        genericRepeat: config?.detectors?.genericRepeat ?? DEFAULTS.detectors.genericRepeat,
        knownPollNoProgress:
          config?.detectors?.knownPollNoProgress ?? DEFAULTS.detectors.knownPollNoProgress,
        pingPong: config?.detectors?.pingPong ?? DEFAULTS.detectors.pingPong,
      },
      knownPollTools: config?.knownPollTools ?? [...DEFAULTS.knownPollTools],
    };
  }

  /**
   * Check if the upcoming tool call would trigger loop detection.
   * Call this BEFORE executing the tool.
   */
  check(toolName: string, params: unknown): LoopDetectionResult {
    if (!this.config.enabled) return { stuck: false };

    const currentHash = hashArgs(toolName, params);
    const noProgress = getNoProgressStreak(this.history, toolName, currentHash);
    const knownPoll = isKnownPollTool(toolName, params, this.config.knownPollTools);
    const pingPong = getPingPongStreak(this.history, currentHash);

    // --- Detector 1: Global circuit breaker (highest priority) ---
    if (noProgress.count >= this.config.globalCircuitBreakerThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'global_circuit_breaker',
        count: noProgress.count,
        message: `BLOCKED: You have called ${toolName} with identical arguments and identical results ${noProgress.count} times. Execution blocked by circuit breaker. Try a completely different approach or report this task as failed.`,
      };
    }

    // --- Detector 2: Known poll no-progress ---
    if (knownPoll && this.config.detectors.knownPollNoProgress) {
      if (noProgress.count >= this.config.criticalThreshold) {
        return {
          stuck: true,
          level: 'critical',
          detector: 'known_poll_no_progress',
          count: noProgress.count,
          message: `BLOCKED: You have polled ${toolName} ${noProgress.count} times with no change in results. The process appears stuck. Stop polling and either increase wait time significantly, or report the task as failed.`,
        };
      }
      if (noProgress.count >= this.config.warningThreshold) {
        const key = `poll:${currentHash}`;
        if (!this.warnedPatterns.has(key)) {
          this.warnedPatterns.add(key);
          return {
            stuck: true,
            level: 'warning',
            detector: 'known_poll_no_progress',
            count: noProgress.count,
            message: `WARNING: You have polled ${toolName} ${noProgress.count} times with identical results. If the process is not progressing, stop polling and report the task status.`,
          };
        }
      }
    }

    // --- Detector 3: Ping-pong ---
    if (this.config.detectors.pingPong) {
      if (pingPong.count >= this.config.criticalThreshold && pingPong.noProgressEvidence) {
        return {
          stuck: true,
          level: 'critical',
          detector: 'ping_pong',
          count: pingPong.count,
          message: `BLOCKED: You are alternating between tool call patterns (${pingPong.count} consecutive calls) with no progress. This is a stuck ping-pong loop. Try a different approach or report the task as failed.`,
        };
      }
      if (pingPong.count >= this.config.warningThreshold) {
        const key = `pingpong:${currentHash}`;
        if (!this.warnedPatterns.has(key)) {
          this.warnedPatterns.add(key);
          return {
            stuck: true,
            level: 'warning',
            detector: 'ping_pong',
            count: pingPong.count,
            message: `WARNING: You appear to be alternating between the same tool calls repeatedly (${pingPong.count} times). If this is not making progress, try a different approach.`,
          };
        }
      }
    }

    // --- Detector 4: Generic repeat (warning only, non-poll tools) ---
    // Fix #3: result-aware — skip if results differ across calls
    if (!knownPoll && this.config.detectors.genericRepeat) {
      const matchingEntries = this.history.filter(
        (h) => h.toolName === toolName && h.argsHash === currentHash
      );
      const recentCount = matchingEntries.length;

      if (recentCount >= this.config.warningThreshold) {
        // Check if results are actually changing (not stuck)
        const entriesWithResults = matchingEntries.filter((e) => e.resultHash != null);
        if (entriesWithResults.length >= 2) {
          const uniqueResults = new Set(entriesWithResults.map((e) => e.resultHash));
          if (uniqueResults.size > 1) {
            // Results are changing — tool is making progress, not stuck
            return { stuck: false };
          }
        }

        const key = `generic:${currentHash}`;
        if (!this.warnedPatterns.has(key)) {
          this.warnedPatterns.add(key);
          return {
            stuck: true,
            level: 'warning',
            detector: 'generic_repeat',
            count: recentCount,
            message: `WARNING: You have called ${toolName} ${recentCount} times with identical arguments. If this is not making progress, try a different approach.`,
          };
        }
      }
    }

    return { stuck: false };
  }

  /**
   * Record a tool call. Called after execution starts.
   * Creates a history entry without a resultHash (patched later by recordOutcome).
   */
  recordCall(toolName: string, params: unknown): void {
    if (!this.config.enabled) return;

    this.history.push({
      toolName,
      argsHash: hashArgs(toolName, params),
      timestamp: Date.now(),
    });

    // Trim to window size
    while (this.history.length > this.config.historySize) {
      this.history.shift();
    }

    // Fix #2: clean expired warnings — remove keys for signatures no longer in window
    this.cleanExpiredWarnings();
  }

  /**
   * Record the outcome of a tool call after execution.
   * Patches the result hash onto the most recent matching call record.
   */
  recordOutcome(toolName: string, params: unknown, resultContent: string): void {
    if (!this.config.enabled) return;

    const argsHash = hashArgs(toolName, params);
    const rHash = hashResult(resultContent);

    // Walk backwards to find the matching call without a result yet
    for (let i = this.history.length - 1; i >= 0; i--) {
      const record = this.history[i];
      if (
        record &&
        record.toolName === toolName &&
        record.argsHash === argsHash &&
        record.resultHash === undefined
      ) {
        record.resultHash = rHash;
        break;
      }
    }
  }

  /**
   * Get statistics about tool call patterns (for debugging/monitoring).
   */
  getStats(): {
    totalCalls: number;
    uniquePatterns: number;
    mostFrequent: { toolName: string; count: number } | null;
  } {
    const patterns = new Map<string, { toolName: string; count: number }>();

    for (const call of this.history) {
      const existing = patterns.get(call.argsHash);
      if (existing) {
        existing.count++;
      } else {
        patterns.set(call.argsHash, { toolName: call.toolName, count: 1 });
      }
    }

    let mostFrequent: { toolName: string; count: number } | null = null;
    for (const pattern of patterns.values()) {
      if (!mostFrequent || pattern.count > mostFrequent.count) {
        mostFrequent = pattern;
      }
    }

    return {
      totalCalls: this.history.length,
      uniquePatterns: patterns.size,
      mostFrequent,
    };
  }

  /** Reset all history and warning state. */
  reset(): void {
    this.history = [];
    this.warnedPatterns.clear();
  }

  /** Get current config (for testing/debugging). */
  getConfig(): Readonly<typeof this.config> {
    return this.config;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Fix #2: Remove warned pattern keys whose signatures no longer appear
   * in the current sliding window. Allows re-warning if the pattern exits
   * and later re-enters the window.
   */
  private cleanExpiredWarnings(): void {
    if (this.warnedPatterns.size === 0) return;

    // Collect all argsHash values currently in the window
    const activeHashes = new Set<string>();
    for (const record of this.history) {
      activeHashes.add(record.argsHash);
    }

    // Remove warned keys whose hash is no longer in the window
    for (const key of this.warnedPatterns) {
      // Keys are formatted as "prefix:toolName:hash" — extract the argsHash part
      const colonIdx = key.indexOf(':');
      const argsHash = colonIdx >= 0 ? key.slice(colonIdx + 1) : key;
      if (!activeHashes.has(argsHash)) {
        this.warnedPatterns.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

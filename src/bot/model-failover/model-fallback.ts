/**
 * Unified Model Failover Orchestrator
 *
 * The main entry point: runWithModelFallback<T>().
 *
 * Wraps any LLM call with an ordered candidate chain, error classification,
 * cooldown awareness, and smart skip/abort logic. This replaces the two
 * disconnected fallback mechanisms we have today (OllamaClient's internal
 * fallback list and LLMClientWithFallback's binary claude→ollama toggle).
 *
 * Transplanted from OpenClaw's model-fallback.ts (570 LOC), adapted for
 * our simpler backend surface. OpenClaw's version includes auth-profile
 * rotation and provider normalization we don't need. What we keep: the
 * core loop logic, the error → skip/abort/continue decisions, and the
 * clean generic wrapper pattern.
 *
 * Target: src/bot/model-failover/model-fallback.ts
 */

import {
  FailoverError,
  type FailoverReason,
  classifyFailoverReason,
  isBackendScoped,
  shouldAbortChain,
} from './failover-error';

import { type CooldownStatus, ProviderCooldownTracker } from './cooldown-tracker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelCandidate {
  /** Backend identifier: 'ollama', 'claude-cli', or future providers */
  backend: string;
  /** Model name (e.g. 'qwen2.5:32b'). Optional for backends like claude-cli
   *  where the model is determined by the CLI config. */
  model?: string;
}

export interface FallbackAttempt {
  backend: string;
  model?: string;
  error: string;
  reason: FailoverReason | null;
  durationMs: number;
}

export interface ModelFallbackResult<T> {
  /** The successful result */
  result: T;
  /** Which backend succeeded */
  backend: string;
  /** Which model succeeded */
  model?: string;
  /** Failed attempts before success (empty if first candidate worked) */
  attempts: FallbackAttempt[];
  /** Whether we fell back (attempts.length > 0) */
  fellBack: boolean;
}

export interface ModelFallbackParams<T> {
  /** Ordered list of candidates to try. First = primary. */
  candidates: ModelCandidate[];
  /** The actual LLM call. Receives the resolved backend+model. */
  run: (backend: string, model: string | undefined) => Promise<T>;
  /** Called after each failed attempt (for logging/metrics). */
  onError?: (info: {
    attempt: FallbackAttempt;
    index: number;
    total: number;
    skipped: boolean;
  }) => void;
  /** Called when a candidate is skipped due to cooldown. */
  onSkip?: (info: {
    candidate: ModelCandidate;
    cooldown: CooldownStatus;
    index: number;
  }) => void;
  /** Shared cooldown tracker instance. If not provided, no cooldown logic. */
  cooldownTracker?: ProviderCooldownTracker;
  /** AbortSignal to cancel the entire chain. */
  signal?: AbortSignal;
}

/**
 * Error thrown when all candidates are exhausted.
 */
export class AllCandidatesExhaustedError extends Error {
  public readonly attempts: FallbackAttempt[];

  constructor(attempts: FallbackAttempt[]) {
    const summary = attempts
      .map(
        (a) => `${a.backend}${a.model ? '/' + a.model : ''}: ${a.reason ?? 'unknown'} (${a.error})`
      )
      .join('; ');
    super(`All model candidates exhausted: ${summary}`);
    this.name = 'AllCandidatesExhaustedError';
    this.attempts = attempts;
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Run an LLM call with model failover.
 *
 * Iterates through candidates in order. For each candidate:
 *   1. Check cooldown — skip if in cooldown (unless it's the last candidate)
 *   2. Execute the run function
 *   3. On success → return result + metadata
 *   4. On error → classify, record cooldown, decide next action
 *
 * Error → action mapping:
 *   context_length  → abort chain (rethrow). No model will do better.
 *   format          → abort chain (rethrow). The request itself is wrong.
 *   auth / billing  → skip all remaining candidates on the SAME backend.
 *   rate_limit      → skip this candidate, try next.
 *   timeout         → skip this candidate, try next.
 *   unknown         → try next if candidates remain, rethrow on last.
 *   AbortError      → rethrow immediately (user cancelled).
 */
export async function runWithModelFallback<T>(
  params: ModelFallbackParams<T>
): Promise<ModelFallbackResult<T>> {
  const { candidates, run, onError, onSkip, cooldownTracker, signal } = params;

  if (candidates.length === 0) {
    throw new Error('runWithModelFallback: candidates list is empty');
  }

  const attempts: FallbackAttempt[] = [];
  const skippedBackends = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const isLast = i === candidates.length - 1;

    // Check abort signal
    if (signal?.aborted) {
      throw new Error('Aborted');
    }

    // Skip if backend was flagged by a previous auth/billing error
    if (skippedBackends.has(candidate.backend)) {
      continue;
    }

    // Check cooldown (but always try the last candidate as a hail mary)
    if (cooldownTracker && !isLast) {
      const key = ProviderCooldownTracker.makeKey(candidate.backend, candidate.model);
      const backendKey = ProviderCooldownTracker.makeKey(candidate.backend, undefined, true);

      const modelCooldown = cooldownTracker.getCooldownStatus(key);
      const backendCooldown = cooldownTracker.getCooldownStatus(backendKey);

      if (modelCooldown.inCooldown || backendCooldown.inCooldown) {
        const cooldown = backendCooldown.inCooldown ? backendCooldown : modelCooldown;
        onSkip?.({ candidate, cooldown, index: i });
        continue;
      }
    }

    // Execute the LLM call
    const startMs = Date.now();
    try {
      const result = await run(candidate.backend, candidate.model);

      // Success — clear cooldown for this candidate
      if (cooldownTracker) {
        const key = ProviderCooldownTracker.makeKey(candidate.backend, candidate.model);
        cooldownTracker.recordSuccess(key);
      }

      return {
        result,
        backend: candidate.backend,
        model: candidate.model,
        attempts,
        fellBack: attempts.length > 0,
      };
    } catch (error: unknown) {
      const durationMs = Date.now() - startMs;

      // Abort errors are never retried
      if (isAbortError(error)) {
        throw error;
      }

      // Classify the error
      const failoverError = classifyFailoverReason(error);
      const reason = failoverError?.reason ?? null;

      const attempt: FallbackAttempt = {
        backend: candidate.backend,
        model: candidate.model,
        error: failoverError?.message ?? extractErrorMessage(error),
        reason,
        durationMs,
      };
      attempts.push(attempt);

      // Record cooldown
      if (cooldownTracker && reason) {
        const scoped = isBackendScoped(reason);
        const key = scoped
          ? ProviderCooldownTracker.makeKey(candidate.backend, undefined, true)
          : ProviderCooldownTracker.makeKey(candidate.backend, candidate.model);
        cooldownTracker.recordFailure(key, reason);
      }

      // Notify callback
      onError?.({
        attempt,
        index: i,
        total: candidates.length,
        skipped: false,
      });

      // Decide next action based on reason
      if (reason && shouldAbortChain(reason)) {
        // context_length, format → no point trying other models
        throw failoverError ?? error;
      }

      if (reason && isBackendScoped(reason)) {
        // auth, billing → skip all remaining models on this backend
        skippedBackends.add(candidate.backend);
      }

      // For everything else (rate_limit, timeout, unknown): continue to next candidate
      if (isLast) {
        // Last candidate failed — throw the classified error if we have one,
        // otherwise throw the original
        if (failoverError) {
          throw new AllCandidatesExhaustedError(attempts);
        }
        throw error;
      }
    }
  }

  // Should be unreachable — but TypeScript needs the return
  throw new AllCandidatesExhaustedError(attempts);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true;
    if (error.message === 'Aborted') return true;
    if (error.message === 'The operation was aborted') return true;
  }
  return false;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

// ---------------------------------------------------------------------------
// Candidate resolution helpers
// ---------------------------------------------------------------------------

/**
 * Build the default candidate chain from config.
 *
 * This reads the framework's config structure and produces an ordered
 * ModelCandidate[] list. If `config.failover.candidates` is explicitly
 * set, use that. Otherwise, synthesize from legacy config:
 *   1. ollama primary model
 *   2. ollama fallback models
 *   3. claude-cli (if configured)
 *
 * Deduplication: later candidates with the same backend+model are removed.
 */
export function resolveCandidatesFromConfig(config: {
  failover?: {
    candidates?: ModelCandidate[];
    cooldownEnabled?: boolean;
  };
  ollama?: {
    models?: {
      primary?: string;
      fallbacks?: string[];
    };
  };
  claudeCli?: {
    enabled?: boolean;
    model?: string;
  };
}): ModelCandidate[] {
  // Explicit candidate list takes priority
  if (config.failover?.candidates && config.failover.candidates.length > 0) {
    return deduplicateCandidates(config.failover.candidates);
  }

  // Synthesize from legacy config
  const candidates: ModelCandidate[] = [];

  // Ollama primary
  if (config.ollama?.models?.primary) {
    candidates.push({ backend: 'ollama', model: config.ollama.models.primary });
  }

  // Ollama fallbacks
  if (config.ollama?.models?.fallbacks) {
    for (const model of config.ollama.models.fallbacks) {
      candidates.push({ backend: 'ollama', model });
    }
  }

  // Claude CLI
  if (config.claudeCli?.enabled !== false) {
    candidates.push({
      backend: 'claude-cli',
      model: config.claudeCli?.model,
    });
  }

  return deduplicateCandidates(candidates);
}

function deduplicateCandidates(candidates: ModelCandidate[]): ModelCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.backend}/${c.model ?? '_default'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { FailoverError, classifyFailoverReason } from './failover-error';
export { ProviderCooldownTracker } from './cooldown-tracker';
export type { FailoverReason } from './failover-error';
export type { CooldownStatus } from './cooldown-tracker';

/**
 * Per-model context windows for the Ollama candidate chain.
 *
 * Why this exists: a `context_length` failure maps to `shouldAbortChain()`
 * (`./failover-error.ts`), so a fallback whose window is smaller than the
 * prompt does not merely fail — it terminates the whole chain and skips every
 * remaining candidate. The historical workaround was to order `fallbacks` from
 * the roomiest model down, which is correct but forces the *slowest* model to
 * the front whenever the roomiest one happens to be a reasoning model.
 *
 * The better lever is the prompt: if the assembled prompt always fits the
 * SMALLEST window in the chain, every candidate can accept it and the chain
 * can be ordered by latency instead. That is what this table feeds — see
 * `resolveContextWindow()` in `src/bot/context-compaction.ts`.
 *
 * MAINTENANCE: this is a hand-maintained table of third-party facts and it
 * will rot. Ollama adds, renames and retires cloud tags on a rolling schedule.
 * An unlisted model contributes NO constraint (see `resolveChainContextWindow`)
 * rather than a guessed one, because silently shrinking an operator's
 * configured budget on the strength of a guess is worse than not clamping.
 * Operators can supply or override entries without a code change via
 * `conversation.compaction.modelContextWindows`.
 */

/** Known context windows in tokens, keyed by the exact Ollama tag. */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  // Cloud tags, verified against Ollama's catalogue on 2026-08-11.
  'kimi-k2.6:cloud': 256_000,
  'nemotron-3-super:cloud': 256_000,
  'gpt-oss:120b-cloud': 128_000,
  'gpt-oss:20b-cloud': 128_000,
  'qwen3.5:397b-cloud': 256_000,
  'deepseek-v3.1:671b-cloud': 128_000,
  // Common local tags, included so a mixed chain is still clamped correctly.
  'llama3.1:8b': 128_000,
  'llama3.2:3b': 128_000,
  'qwen2.5-coder:32b': 32_768,
  'mistral:7b': 32_768,
  'nomic-embed-text:latest': 8_192,
});

export interface ChainContextWindow {
  /**
   * Smallest known window across the chain, or `undefined` when no member is
   * known — in which case the caller must not clamp.
   */
  tokens?: number;
  /** Tag whose window produced `tokens`. */
  limitingModel?: string;
  /** Chain members absent from both the table and the operator overrides. */
  unknownModels: string[];
}

/** Look a single tag up in the overrides first, then the built-in table. */
export function resolveModelContextWindow(
  model: string,
  overrides?: Readonly<Record<string, number>>
): number | undefined {
  const tag = model.trim();
  if (!tag) return undefined;
  const override = overrides?.[tag];
  if (typeof override === 'number' && override > 0) return override;
  return MODEL_CONTEXT_WINDOWS[tag];
}

/**
 * Reduce a candidate chain to the smallest context window any member can be
 * relied on to accept.
 *
 * Unknown tags are reported but do not participate: with no evidence about a
 * model, the honest answer is "no additional constraint", and the caller keeps
 * whatever budget the operator configured.
 */
export function resolveChainContextWindow(
  models: readonly (string | undefined)[],
  overrides?: Readonly<Record<string, number>>
): ChainContextWindow {
  const unknownModels: string[] = [];
  let tokens: number | undefined;
  let limitingModel: string | undefined;

  for (const candidate of models) {
    const tag = candidate?.trim();
    if (!tag) continue;
    const window = resolveModelContextWindow(tag, overrides);
    if (window === undefined) {
      if (!unknownModels.includes(tag)) unknownModels.push(tag);
      continue;
    }
    if (tokens === undefined || window < tokens) {
      tokens = window;
      limitingModel = tag;
    }
  }

  return { tokens, limitingModel, unknownModels };
}

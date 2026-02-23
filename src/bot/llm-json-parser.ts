import type { Logger } from '../logger';

/**
 * Options for parsing LLM JSON output.
 */
export interface ParseLLMJsonOptions<T> {
  /** Regex to extract JSON from surrounding prose (e.g. /\{[\s\S]*"plan"[\s\S]*\}/) */
  extractPattern?: RegExp;
  /** Validate and transform the parsed object; return null to reject */
  validate: (parsed: any) => T | null;
  /** Label for log messages (e.g. 'planner', 'strategist') */
  label: string;
}

/**
 * Generic LLM JSON parser that handles common LLM output quirks:
 * - Markdown code fences (```json ... ```)
 * - Prose surrounding JSON
 * - JSON.parse + validation
 *
 * Returns T on success, null on failure (logs warnings).
 */
export function parseLLMJson<T>(
  raw: string,
  logger: Pick<Logger, 'warn'>,
  opts: ParseLLMJsonOptions<T>,
): T | null {
  let cleaned = raw.trim();

  // Strip markdown fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Extract JSON from surrounding prose
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    if (opts.extractPattern) {
      const match = cleaned.match(opts.extractPattern);
      if (match) cleaned = match[0];
    }
  }

  try {
    const parsed = JSON.parse(cleaned);
    const result = opts.validate(parsed);
    if (result === null) {
      logger.warn(
        { raw: raw.slice(0, 300) },
        `Agent loop: ${opts.label} result missing required fields`,
      );
    }
    return result;
  } catch {
    logger.warn(
      { raw: raw.slice(0, 500) },
      `Agent loop: failed to parse ${opts.label} JSON`,
    );
    return null;
  }
}

/**
 * truncate-tool-result.ts — GAP-TR1 Phase 1
 *
 * Tool result truncation with smart tail preservation.
 * Adapted from OpenClaw's tool-result-truncation.ts pattern.
 *
 * WHERE TO PLACE: src/tools/truncate-tool-result.ts
 *
 * INTEGRATION POINT: Called from ToolExecutor.execute() after the tool
 * returns its result but before emitting 'tool:end' and returning.
 * See 28_gap-tr1-implementation-design.md for exact insertion instructions.
 *
 * @module
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum fraction of context window a single tool result may consume.
 * 30% is OpenClaw's default — aggressive enough to prevent context hogging,
 * generous enough for most real outputs.
 */
const CONTEXT_WINDOW_FRACTION = 0.3;

/**
 * Absolute character ceiling. Even if context window is huge, no single
 * result should exceed this. 400K chars ≈ ~100K tokens (rough 4:1 estimate).
 */
const ABSOLUTE_MAX_CHARS = 400_000;

/**
 * Minimum result length to even consider truncation.
 * Short results are never truncated — the overhead isn't worth it.
 */
const MIN_TRUNCATION_THRESHOLD = 5_000;

/**
 * How many chars from the tail to inspect for important content.
 */
const TAIL_INSPECTION_SIZE = 2_000;

/**
 * How many chars from the tail to preserve when using head+tail strategy.
 * This is the "tail window" — the last N chars kept when middle is omitted.
 */
const TAIL_PRESERVE_SIZE = 3_000;

/**
 * Marker inserted at the truncation point so the LLM knows content was omitted.
 */
const TRUNCATION_MARKER =
  '\n\n... [Output truncated: {omitted} chars omitted from middle. Showing first {headSize} and last {tailSize} chars.] ...\n\n';

const SIMPLE_TRUNCATION_MARKER =
  '\n\n... [Output truncated at {kept} of {total} chars. Use offset parameter to see more.] ...';

// ─── Core Logic ──────────────────────────────────────────────────────────────

/**
 * Detects whether the tail of a text contains "important" content that
 * should be preserved during truncation. Important content includes:
 *
 * - Error messages, exceptions, stack traces
 * - JSON closing braces (partial JSON is worse than no JSON)
 * - Summary/result/completion markers
 *
 * Adapted from OpenClaw's hasImportantTail().
 */
export function hasImportantTail(text: string): boolean {
  const tail = text.slice(-TAIL_INSPECTION_SIZE).toLowerCase();

  // Error/failure patterns — the most common reason to preserve tail
  if (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code|segfault|abort|killed|oom)\b/.test(
      tail
    )
  ) {
    return true;
  }

  // JSON/structured data closing — truncating mid-JSON is catastrophic for parsing
  if (/\}\s*$/.test(tail.trim())) {
    return true;
  }

  // Summary/completion markers — the tail contains the "answer"
  if (/\b(total|summary|result|complete|finished|done|passed|failed|ok|success)\b/.test(tail)) {
    return true;
  }

  // Exit codes and return values
  if (/exit\s*(code|status)\s*[:=]?\s*\d+/.test(tail)) {
    return true;
  }

  return false;
}

/**
 * Finds the nearest newline boundary to avoid cutting mid-line.
 * Searches backward from `pos` up to `maxSearch` chars.
 * Returns `pos` if no newline found within search range.
 */
function findNewlineBoundary(text: string, pos: number, maxSearch = 200): number {
  const searchStart = Math.max(0, pos - maxSearch);
  const lastNewline = text.lastIndexOf('\n', pos);
  if (lastNewline >= searchStart) {
    return lastNewline + 1; // Include the newline, cut after it
  }
  return pos;
}

/**
 * Finds the nearest newline boundary searching forward from `pos`.
 * Used for the tail start position — we want to start on a clean line.
 */
function findNewlineBoundaryForward(text: string, pos: number, maxSearch = 200): number {
  const searchEnd = Math.min(text.length, pos + maxSearch);
  const nextNewline = text.indexOf('\n', pos);
  if (nextNewline >= 0 && nextNewline <= searchEnd) {
    return nextNewline + 1;
  }
  return pos;
}

export interface TruncationResult {
  /** The (possibly truncated) text */
  content: string;
  /** Whether truncation was applied */
  wasTruncated: boolean;
  /** Original length in chars */
  originalLength: number;
  /** Strategy used: 'none' | 'head_only' | 'head_tail' */
  strategy: 'none' | 'head_only' | 'head_tail';
}

/**
 * Truncates a tool result string if it exceeds the computed maximum.
 *
 * Two strategies:
 *
 * 1. **head_only** (default): Keep the first N chars, append truncation notice.
 *    Used when the tail doesn't contain anything special.
 *
 * 2. **head_tail**: Keep the first M chars AND the last K chars, omit the middle.
 *    Used when `hasImportantTail()` detects errors, results, or structured data
 *    at the end. This way the LLM sees the beginning of the output (context) AND
 *    the error at the bottom (the important part).
 *
 * @param text - The raw tool result text
 * @param contextWindowChars - Total context window size in chars (estimated).
 *   For Ollama with num_ctx=8192 tokens, this would be ~32768 chars.
 *   Pass 0 or undefined to use only the absolute max.
 */
export function truncateToolResult(text: string, contextWindowChars?: number): TruncationResult {
  const originalLength = text.length;

  // Short-circuit: nothing to truncate
  if (originalLength <= MIN_TRUNCATION_THRESHOLD) {
    return { content: text, wasTruncated: false, originalLength, strategy: 'none' };
  }

  // Compute effective maximum
  let maxChars = ABSOLUTE_MAX_CHARS;
  if (contextWindowChars && contextWindowChars > 0) {
    const windowMax = Math.floor(contextWindowChars * CONTEXT_WINDOW_FRACTION);
    maxChars = Math.min(maxChars, windowMax);
  }

  // Ensure minimum viable size (don't truncate to something uselessly small)
  maxChars = Math.max(maxChars, MIN_TRUNCATION_THRESHOLD);

  // No truncation needed
  if (originalLength <= maxChars) {
    return { content: text, wasTruncated: false, originalLength, strategy: 'none' };
  }

  // ─── Truncation needed ───

  if (hasImportantTail(text)) {
    // Strategy: head + tail
    const tailSize = Math.min(TAIL_PRESERVE_SIZE, Math.floor(maxChars * 0.3));
    const headSize = maxChars - tailSize;

    // Find clean cut points
    const headEnd = findNewlineBoundary(text, headSize);
    const tailStart = findNewlineBoundaryForward(text, originalLength - tailSize);

    // Safety: if head and tail overlap, fall back to head-only
    if (headEnd >= tailStart) {
      return truncateHeadOnly(text, maxChars, originalLength);
    }

    const head = text.slice(0, headEnd);
    const tail = text.slice(tailStart);
    const omitted = originalLength - head.length - tail.length;

    const marker = TRUNCATION_MARKER.replace('{omitted}', omitted.toLocaleString())
      .replace('{headSize}', head.length.toLocaleString())
      .replace('{tailSize}', tail.length.toLocaleString());

    return {
      content: head + marker + tail,
      wasTruncated: true,
      originalLength,
      strategy: 'head_tail',
    };
  }

  // Strategy: head only
  return truncateHeadOnly(text, maxChars, originalLength);
}

function truncateHeadOnly(
  text: string,
  maxChars: number,
  originalLength: number
): TruncationResult {
  const cutPoint = findNewlineBoundary(text, maxChars);
  const head = text.slice(0, cutPoint);

  const marker = SIMPLE_TRUNCATION_MARKER.replace('{kept}', head.length.toLocaleString()).replace(
    '{total}',
    originalLength.toLocaleString()
  );

  return {
    content: head + marker,
    wasTruncated: true,
    originalLength,
    strategy: 'head_only',
  };
}

// ─── Context Window Estimation ───────────────────────────────────────────────

/**
 * Rough chars-per-token multiplier. For English text, 1 token ≈ 4 chars.
 * This is intentionally conservative (overestimates chars per token)
 * so we truncate a bit less aggressively than necessary.
 *
 * When we get proper token counting, replace this with real tokenization.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Converts a token-based context window size to approximate char count.
 * Used when only the token count is available (e.g., Ollama's num_ctx).
 */
export function tokensToChars(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

// ─── Integration Helper ──────────────────────────────────────────────────────

/**
 * Applies truncation to a ToolResult-shaped object.
 * This is the function ToolExecutor should call.
 *
 * Usage in tool-executor.ts:
 *
 *   import { truncateToolResultContent } from './truncate-tool-result';
 *
 *   // After tool execution, before returning:
 *   const truncated = truncateToolResultContent(result.content, contextWindowChars);
 *   if (truncated.wasTruncated) {
 *     result.content = truncated.content;
 *     logger.debug(`Tool result truncated: ${truncated.originalLength} → ${truncated.content.length} chars (${truncated.strategy})`);
 *   }
 *
 * @param content - The tool result content string
 * @param contextWindowChars - Context window in chars (use tokensToChars() to convert)
 */
export function truncateToolResultContent(
  content: string,
  contextWindowChars?: number
): TruncationResult {
  // Handle non-string content gracefully
  if (typeof content !== 'string') {
    const serialized = JSON.stringify(content);
    return truncateToolResult(serialized, contextWindowChars);
  }
  return truncateToolResult(content, contextWindowChars);
}

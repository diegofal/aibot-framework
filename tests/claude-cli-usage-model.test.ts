import { describe, expect, it } from 'bun:test';
import { parseClaudeUsage } from '../src/claude-cli';

/**
 * The CLI's `--output-format json` result has no top-level `model`; the ids
 * live as keys of `modelUsage`, which also lists the CLI's own auxiliary
 * Haiku calls. The LLM query log reads `usage.model`, so this decides whether
 * the log says which model actually answered or just "claude".
 */
const tokens = { input_tokens: 10, output_tokens: 5 };
const modelEntry = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheCreation,
});

describe('parseClaudeUsage', () => {
  it('returns undefined when the result carries no token usage', () => {
    expect(parseClaudeUsage({ result: 'OK' })).toBeUndefined();
  });

  it('reads the model id from modelUsage', () => {
    const usage = parseClaudeUsage({
      usage: tokens,
      modelUsage: { 'claude-sonnet-5-5': modelEntry(2, 4, 10345, 8909) },
    });
    expect(usage).toEqual({
      model: 'claude-sonnet-5-5',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('picks the model that did the work over auxiliary Haiku calls', () => {
    const usage = parseClaudeUsage({
      usage: tokens,
      modelUsage: {
        'claude-haiku-4-5-20251001': modelEntry(400, 30),
        'claude-fable-5-1': modelEntry(2, 4, 10345, 8909),
      },
    });
    expect(usage?.model).toBe('claude-fable-5-1');
  });

  it('prefers a top-level model string when one is present', () => {
    const usage = parseClaudeUsage({
      usage: tokens,
      model: 'claude-opus-5-5',
      modelUsage: { 'claude-haiku-4-5': modelEntry(400, 30) },
    });
    expect(usage?.model).toBe('claude-opus-5-5');
  });

  it('falls back to "claude" when modelUsage is missing or malformed', () => {
    expect(parseClaudeUsage({ usage: tokens })?.model).toBe('claude');
    expect(parseClaudeUsage({ usage: tokens, modelUsage: [] })?.model).toBe('claude');
    expect(parseClaudeUsage({ usage: tokens, modelUsage: {} })?.model).toBe('claude');
  });
});

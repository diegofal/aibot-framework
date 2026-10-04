import { describe, expect, it } from 'bun:test';
import { CLAUDE_CLI_MODEL_OPTIONS } from '../src/claude-cli';

/**
 * The Settings page's Claude CLI model dropdown is built from this list, so
 * it must stay well-formed: unique values, the empty "CLI default" first,
 * every rolling alias the CLI documents, and a pinned id per current tier.
 */
describe('CLAUDE_CLI_MODEL_OPTIONS', () => {
  it('starts with the empty CLI-default option', () => {
    expect(CLAUDE_CLI_MODEL_OPTIONS[0].value).toBe('');
    expect(CLAUDE_CLI_MODEL_OPTIONS[0].label).toContain('CLI default');
  });
  it('has unique, labelled values', () => {
    const values = CLAUDE_CLI_MODEL_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    for (const o of CLAUDE_CLI_MODEL_OPTIONS) expect(o.label.length).toBeGreaterThan(0);
  });
  it('offers the rolling aliases and the pinned Claude 5 ids', () => {
    const values = new Set(CLAUDE_CLI_MODEL_OPTIONS.map((o) => o.value));
    for (const v of ['opus', 'sonnet', 'haiku', 'fable']) expect(values.has(v)).toBe(true);
    for (const v of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']) {
      expect(values.has(v)).toBe(true);
    }
  });
  it('offers the pinned Claude 5.5 / Fable 5.1 ids', () => {
    const values = new Set(CLAUDE_CLI_MODEL_OPTIONS.map((o) => o.value));
    for (const v of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
      expect(values.has(v)).toBe(true);
    }
  });
  it('marks Sonnet 5.5 as the only recommended default', () => {
    const recommended = CLAUDE_CLI_MODEL_OPTIONS.filter((o) => o.label.includes('recommended'));
    expect(recommended.map((o) => o.value)).toEqual(['claude-sonnet-5-5']);
  });
});

/**
 * The three spawns of the Claude CLI outside src/claude-cli.ts carry the
 * shared flags: --setting-sources "" on every one, --tools "" on the one that
 * uses no tools (the consolidator). The reviewer and improve use Read/Edit/Write.
 */
import { describe, expect, test } from 'bun:test';
import { buildConsolidationCliArgs } from '../src/bot/soul-memory-consolidator';
import { buildQualityReviewCliArgs } from '../src/bot/soul-quality-reviewer';
import { NO_SETTINGS_FLAGS, NO_TOOLS_LEAN_FLAGS, SKIP_PERMISSIONS_FLAG } from '../src/claude-cli';
import { buildImproveCliArgs } from '../src/tools/improve';

function containsRun(args: string[], run: readonly string[]): boolean {
  for (let i = 0; i + run.length <= args.length; i++) {
    if (run.every((v, j) => args[i + j] === v)) return true;
  }
  return false;
}

describe('direct Claude CLI spawns', () => {
  test('the memory consolidator: no tools, no settings, text output, model last', () => {
    const args = buildConsolidationCliArgs('/bin/claude', 'PROMPT', 'claude-haiku-5-5');
    expect(args.slice(0, 3)).toEqual(['/bin/claude', '-p', 'PROMPT']);
    expect(containsRun(args, ['--output-format', 'text'])).toBe(true);
    expect(args).toContain(SKIP_PERMISSIONS_FLAG);
    expect(containsRun(args, NO_TOOLS_LEAN_FLAGS)).toBe(true);
    expect(args.slice(-2)).toEqual(['--model', 'claude-haiku-5-5']);
    expect(buildConsolidationCliArgs('/bin/claude', 'PROMPT')).not.toContain('--model');
  });

  test('the quality reviewer: its file tools, no settings', () => {
    const args = buildQualityReviewCliArgs('/bin/claude', 'PROMPT', 'm');
    expect(containsRun(args, ['--allowedTools', 'Read,Edit,Write'])).toBe(true);
    expect(containsRun(args, NO_SETTINGS_FLAGS)).toBe(true);
    expect(args).not.toContain('--tools');
    expect(args.slice(-2)).toEqual(['--model', 'm']);
  });

  test('improve: its file tools, no settings', () => {
    const args = buildImproveCliArgs('PROMPT', 'm');
    expect(args.slice(0, 2)).toEqual(['-p', 'PROMPT']);
    expect(containsRun(args, ['--allowedTools', 'Read,Edit,Write,Glob,Grep'])).toBe(true);
    expect(containsRun(args, NO_SETTINGS_FLAGS)).toBe(true);
    expect(args).not.toContain('--tools');
    expect(buildImproveCliArgs('PROMPT')).not.toContain('--model');
  });
});

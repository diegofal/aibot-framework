import { describe, expect, test } from 'bun:test';
import {
  NO_SETTINGS_FLAGS,
  NO_TOOLS_LEAN_FLAGS,
  SKIP_PERMISSIONS_FLAG,
  buildClaudeGenerateArgs,
  buildClaudeToolsArgs,
} from '../src/claude-cli';

/**
 * The no-tools path (planner, strategist, memory, watcher) used to load the
 * CLI's whole native tool set and default system prompt: ~28k cached tokens
 * per call. `--tools ""` + `--setting-sources ""` drop both.
 */
describe('buildClaudeGenerateArgs (no-tools path)', () => {
  test('always passes --tools "" and --setting-sources ""', () => {
    const { args } = buildClaudeGenerateArgs('claude', 'hi', {});
    const t = args.indexOf('--tools');
    expect(t).toBeGreaterThan(0);
    expect(args[t + 1]).toBe('');
    const s = args.indexOf('--setting-sources');
    expect(s).toBeGreaterThan(0);
    expect(args[s + 1]).toBe('');
    expect(args).toContain(SKIP_PERMISSIONS_FLAG);
    expect(NO_TOOLS_LEAN_FLAGS).toEqual(['--tools', '', '--setting-sources', '']);
  });

  test('carries model and system prompt', () => {
    const { args } = buildClaudeGenerateArgs('claude', 'hi', {
      model: 'claude-haiku-5-5',
      systemPrompt: 'You are the watcher.',
    });
    expect(args[0]).toBe('claude');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'claude-haiku-5-5',
    ]);
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('You are the watcher.');
  });

  test('images still go on stdin with the lean flags', () => {
    const { args, stdin } = buildClaudeGenerateArgs('claude', 'look', { images: ['aGVsbG8='] });
    expect(stdin).toBeDefined();
    expect(args).toContain('--tools');
    expect(args).toContain('--setting-sources');
  });
});

describe('buildClaudeToolsArgs (MCP path)', () => {
  // Deliberate change (2026-10-23): --setting-sources "" now goes on both
  // paths so CLAUDE_CONFIG_DIR settings apply to no call instead of to tools
  // calls only; --tools "" stays off here (it would hide the bridge).
  test('passes --setting-sources "" but never --tools "": MCP tools must stay reachable', () => {
    const { args } = buildClaudeToolsArgs('claude', 'hi', {
      mcpConfigPath: '/tmp/mcp.json',
      allowedTools: ['mcp__aibot-tools__x'],
      disallowedNativeTools: ['Bash'],
      model: 'opus',
      systemPrompt: 'sys',
    });
    expect(args).not.toContain('--tools');
    const s = args.indexOf('--setting-sources');
    expect(s).toBeGreaterThan(0);
    expect(args[s + 1]).toBe('');
    expect(NO_SETTINGS_FLAGS).toEqual(['--setting-sources', '']);
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp.json');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__aibot-tools__x');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('sys');
  });
});

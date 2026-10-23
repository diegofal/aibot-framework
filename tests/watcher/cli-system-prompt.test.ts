import { describe, expect, test } from 'bun:test';
import { buildClaudeGenerateArgs } from '../../src/claude-cli';
import { flattenForClaudeCli } from '../../src/core/llm-client';
import { buildNoticePrompt } from '../../src/watcher/prompts';

/**
 * A watcher call is cheap on the Claude CLI only when its instructions reach
 * `--system-prompt` (replacing the CLI's default prompt). The watcher sends
 * `[system, user]`; the CLI client must map the system message there.
 */
describe('watcher prompts reach --system-prompt on the Claude CLI', () => {
  const prompt = buildNoticePrompt(
    [
      {
        id: 'b-11111111',
        botId: 'b1',
        bot: 'Jarvis',
        at: '2026-10-23T10:00:00.000Z',
        what: 'web_fetch failed in Jarvis',
        salience: 0.5,
        reasons: ['tool error'],
        fromOperator: false,
      },
    ],
    []
  );

  test('the notice prompt splits instructions (system) from data (user)', () => {
    expect(prompt.system.length).toBeGreaterThan(200);
    expect(prompt.system).not.toContain('b-11111111');
    expect(prompt.user).toContain('b-11111111');
  });

  test('flatten maps the system message to the CLI system prompt, not the -p text', () => {
    const flat = flattenForClaudeCli([
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ]);
    expect(flat.system).toBe(prompt.system);
    expect(flat.prompt).not.toContain(prompt.system);
    const { args } = buildClaudeGenerateArgs('claude', flat.prompt, {
      systemPrompt: flat.system,
      model: 'claude-haiku-5-5',
    });
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(prompt.system);
  });

  test('flatten keeps user/assistant/tool turns labelled in the prompt', () => {
    const flat = flattenForClaudeCli([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', content: 'ok' },
    ]);
    expect(flat.system).toBeUndefined();
    expect(flat.prompt).toBe('User: hi\n\nAssistant: hello\n\nTool Result: ok');
  });
});

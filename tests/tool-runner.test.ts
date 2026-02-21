import { describe, test, expect } from 'bun:test';
import { runToolLoop, type ToolCallingStrategy, type ToolRunnerOptions } from '../src/core/tool-runner';
import type { ChatMessage, ChatOptions } from '../src/ollama';
import type { ToolDefinition, ToolCall } from '../src/tools/types';

const dummyTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'test_tool',
    description: 'A test tool',
    parameters: { type: 'object', properties: {} },
  },
};

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

function makeToolCall(name = 'test_tool'): ToolCall {
  return { function: { name, arguments: {} } };
}

describe('runToolLoop', () => {
  test('injects summarization prompt on last round', async () => {
    const capturedMessages: ChatMessage[][] = [];
    let callCount = 0;

    const strategy: ToolCallingStrategy = {
      async chat(messages, _opts) {
        capturedMessages.push([...messages]);
        callCount++;
        // First call: return a tool call; second call (last round): return text
        if (callCount === 1) {
          return { content: '', toolCalls: [makeToolCall()] };
        }
        return { content: 'Summary of work done.' };
      },
    };

    const opts: ToolRunnerOptions = {
      maxRounds: 1,
      tools: [dummyTool],
      toolExecutor: async () => ({ success: true, content: 'tool output' }),
      logger: noopLogger,
    };

    const result = await runToolLoop(strategy, [{ role: 'user', content: 'do stuff' }], opts, {});

    expect(result).toBe('Summary of work done.');
    // The last call's messages should include the summarization system message
    const lastCallMessages = capturedMessages[capturedMessages.length - 1];
    const summarizationMsg = lastCallMessages.find(
      (m) => m.role === 'system' && m.content.includes('maximum number of tool call rounds'),
    );
    expect(summarizationMsg).toBeDefined();
  });

  test('does not inject summarization prompt on normal rounds', async () => {
    const capturedMessages: ChatMessage[][] = [];

    const strategy: ToolCallingStrategy = {
      async chat(messages, _opts) {
        capturedMessages.push([...messages]);
        // Return text immediately (no tool calls) — only round 0
        return { content: 'Direct response.' };
      },
    };

    const opts: ToolRunnerOptions = {
      maxRounds: 3,
      tools: [dummyTool],
      toolExecutor: async () => ({ success: true, content: 'tool output' }),
      logger: noopLogger,
    };

    await runToolLoop(strategy, [{ role: 'user', content: 'hello' }], opts, {});

    // Only one call, on round 0 (not last round)
    expect(capturedMessages).toHaveLength(1);
    const hasPrompt = capturedMessages[0].some(
      (m) => m.role === 'system' && m.content.includes('maximum number of tool call rounds'),
    );
    expect(hasPrompt).toBe(false);
  });

  test('returns summary text when LLM responds on last round', async () => {
    let callCount = 0;

    const strategy: ToolCallingStrategy = {
      async chat(_messages, _opts) {
        callCount++;
        if (callCount <= 2) {
          return { content: '', toolCalls: [makeToolCall()] };
        }
        return { content: 'Created 3 files and ran tests successfully.' };
      },
    };

    const opts: ToolRunnerOptions = {
      maxRounds: 2,
      tools: [dummyTool],
      toolExecutor: async () => ({ success: true, content: 'ok' }),
      logger: noopLogger,
    };

    const result = await runToolLoop(strategy, [{ role: 'user', content: 'work' }], opts, {});
    expect(result).toBe('Created 3 files and ran tests successfully.');
  });

  test('returns fallback message when LLM returns empty on last round', async () => {
    let callCount = 0;

    const strategy: ToolCallingStrategy = {
      async chat(_messages, _opts) {
        callCount++;
        if (callCount <= 2) {
          return { content: '', toolCalls: [makeToolCall()] };
        }
        // LLM returns empty even on last round
        return { content: '' };
      },
    };

    const opts: ToolRunnerOptions = {
      maxRounds: 2,
      tools: [dummyTool],
      toolExecutor: async () => ({ success: true, content: 'ok' }),
      logger: noopLogger,
    };

    const result = await runToolLoop(strategy, [{ role: 'user', content: 'work' }], opts, {});
    // Falls through the loop → returns the exhaustion fallback
    expect(result).toBe('I was unable to complete the request within the allowed number of steps.');
  });
});

import { describe, expect, test } from 'bun:test';
import {
  type ToolCallingStrategy,
  type ToolRunnerOptions,
  detectPhantomMemorySave,
  runToolLoop,
} from '../src/core/tool-runner';
import type { ChatMessage, ChatOptions } from '../src/ollama';
import type { ToolCall, ToolDefinition } from '../src/tools/types';

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

    expect(result.text).toBe('Summary of work done.');
    // The last call's messages should include the summarization system message
    const lastCallMessages = capturedMessages[capturedMessages.length - 1];
    const summarizationMsg = lastCallMessages.find(
      (m) => m.role === 'system' && m.content.includes('maximum number of tool call rounds')
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
      (m) => m.role === 'system' && m.content.includes('maximum number of tool call rounds')
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
    expect(result.text).toBe('Created 3 files and ran tests successfully.');
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
    expect(result.text).toBe(
      'I was unable to complete the request within the allowed number of steps.'
    );
  });

  test('logs warning when LLM claims memory save without calling memory tool', async () => {
    const warnings: { msg: string; data: any }[] = [];
    const warnLogger = {
      ...noopLogger,
      warn: (data: any, msg: string) => warnings.push({ msg, data }),
    };

    const strategy: ToolCallingStrategy = {
      async chat(_messages, _opts) {
        return { content: 'Guardado en memoria estructurada.' };
      },
    };

    const opts: ToolRunnerOptions = {
      maxRounds: 5,
      tools: [dummyTool],
      toolExecutor: async () => ({ success: true, content: 'ok' }),
      logger: warnLogger as any,
    };

    const result = await runToolLoop(strategy, [{ role: 'user', content: 'save this' }], opts, {});
    expect(result.text).toBe('Guardado en memoria estructurada.');
    expect(warnings.some((w) => w.msg.includes('Phantom memory save'))).toBe(true);
  });

  test('does not log phantom warning when memory tool was actually called', async () => {
    const warnings: { msg: string; data: any }[] = [];
    const warnLogger = {
      ...noopLogger,
      warn: (data: any, msg: string) => warnings.push({ msg, data }),
    };

    let callCount = 0;
    const strategy: ToolCallingStrategy = {
      async chat(_messages, _opts) {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            toolCalls: [{ function: { name: 'save_memory', arguments: { fact: 'test' } } }],
          };
        }
        return { content: 'Guardado en memoria.' };
      },
    };

    const opts: ToolRunnerOptions = {
      maxRounds: 5,
      tools: [dummyTool],
      toolExecutor: async () => ({ success: true, content: 'ok' }),
      logger: warnLogger as any,
    };

    await runToolLoop(strategy, [{ role: 'user', content: 'save this' }], opts, {});
    expect(warnings.some((w) => w.msg.includes('Phantom memory save'))).toBe(false);
  });
});

describe('detectPhantomMemorySave', () => {
  test('detects Spanish phantom save patterns', () => {
    expect(detectPhantomMemorySave('Guardado en memoria.', new Set())).toBe(true);
    expect(detectPhantomMemorySave('Lo guardo en memoria estructurada.', new Set())).toBe(true);
    expect(detectPhantomMemorySave('Guardé en core memory.', new Set())).toBe(true);
    expect(detectPhantomMemorySave('Anotado en memoria.', new Set())).toBe(true);
  });

  test('detects English phantom save patterns', () => {
    expect(detectPhantomMemorySave('Saved to memory.', new Set())).toBe(true);
    expect(detectPhantomMemorySave('Stored in core memory.', new Set())).toBe(true);
  });

  test('returns false when memory tool was called', () => {
    expect(detectPhantomMemorySave('Guardado en memoria.', new Set(['save_memory']))).toBe(false);
    expect(detectPhantomMemorySave('Stored in core memory.', new Set(['core_memory_append']))).toBe(
      false
    );
    expect(detectPhantomMemorySave('Guardado en memoria.', new Set(['core_memory_replace']))).toBe(
      false
    );
  });

  test('returns false for unrelated responses', () => {
    expect(detectPhantomMemorySave('Hello, how are you?', new Set())).toBe(false);
    expect(detectPhantomMemorySave('Guardado el archivo.', new Set())).toBe(false);
    expect(detectPhantomMemorySave('Memory is important.', new Set())).toBe(false);
  });

  test('returns false when non-memory tools were called but text is clean', () => {
    expect(detectPhantomMemorySave('Done.', new Set(['file_write']))).toBe(false);
  });
});

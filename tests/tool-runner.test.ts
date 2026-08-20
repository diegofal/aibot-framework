import { describe, expect, test } from 'bun:test';
import {
  type ToolCallingStrategy,
  type ToolRunnerOptions,
  detectPhantomMemorySave,
  runToolLoop,
} from '../src/core/tool-runner';
import { createLoopDetector } from '../src/core/loop-detector';
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

  describe('cleanBreak', () => {
    test('cleanBreak: true does not leak the loop marker', async () => {
      let callCount = 0;
      const strategy: ToolCallingStrategy = {
        async chat(_messages, _opts) {
          callCount++;
          if (callCount <= 4) {
            return { content: '', toolCalls: [makeToolCall('test_tool')] };
          }
          return { content: 'Summary text.' };
        },
      };

      const result = await runToolLoop(
        strategy,
        [{ role: 'user', content: 'work' }],
        {
          maxRounds: 10,
          tools: [dummyTool],
          toolExecutor: async () => ({ success: true, content: 'ok' }),
          logger: noopLogger,
          loopDetector: createLoopDetector(10),
          cleanBreak: true,
        },
        {}
      );

      expect(result.text).not.toContain('[Loop stopped:');
    });

    test('cleanBreak: true issues a final tools-less summarization round', async () => {
      let callCount = 0;
      const capturedOpts: ChatOptions[] = [];
      const capturedMessages: ChatMessage[][] = [];
      const strategy: ToolCallingStrategy = {
        async chat(messages, opts) {
          capturedOpts.push({ ...opts });
          capturedMessages.push([...messages]);
          callCount++;
          // First 4 calls: same tool call → repeat detector trips.
          if (callCount <= 4) {
            return { content: '', toolCalls: [makeToolCall('test_tool')] };
          }
          // Final summarization round: no tools, with the "do NOT call" instruction.
          return { content: 'Summary.' };
        },
      };

      await runToolLoop(
        strategy,
        [{ role: 'user', content: 'work' }],
        {
          maxRounds: 10,
          tools: [dummyTool],
          toolExecutor: async () => ({ success: true, content: 'ok' }),
          logger: noopLogger,
          loopDetector: createLoopDetector(10),
          cleanBreak: true,
        },
        {}
      );

      const lastOpts = capturedOpts[capturedOpts.length - 1];
      expect(lastOpts.tools).toBeUndefined();
      expect(lastOpts.toolExecutor).toBeUndefined();

      const lastMessages = capturedMessages[capturedMessages.length - 1];
      const injected = lastMessages[lastMessages.length - 1];
      expect(injected.role).toBe('system');
      expect(injected.content).toContain('Do NOT call any more tools');
      expect(injected.content).toContain('safety limit');
    });

    test('cleanBreak: true handles a global circuit-breaker break end-to-end', async () => {
      let callCount = 0;
      const breakInfos: any[] = [];
      const strategy: ToolCallingStrategy = {
        async chat() {
          callCount++;
          // Each round returns 2 parallel tool calls with unique args + the executor
          // returns unique results. With maxRounds=3, globalLimit=maxRounds*2=6.
          // After round 1 the detector has 2 calls, after round 2: 4, after round 3: 6 → break.
          if (callCount <= 3) {
            return {
              content: '',
              toolCalls: [
                {
                  function: { name: 'test_tool', arguments: { round: callCount, i: 1 } },
                },
                {
                  function: { name: 'test_tool', arguments: { round: callCount, i: 2 } },
                },
              ],
            };
          }
          return { content: 'Partial results summarized.' };
        },
      };

      const result = await runToolLoop(
        strategy,
        [{ role: 'user', content: 'research' }],
        {
          maxRounds: 3,
          tools: [dummyTool],
          toolExecutor: async () => ({ success: true, content: `r${callCount}` }),
          logger: noopLogger,
          loopDetector: createLoopDetector(3),
          cleanBreak: true,
          onLoopBreak: (info) => breakInfos.push(info),
        },
        {}
      );

      expect(result.stopReason).toBe('loop-break');
      expect(result.text).not.toContain('[Loop stopped:');
      expect(result.text).toBe('Partial results summarized.');
      expect(breakInfos).toHaveLength(1);
      expect(breakInfos[0].detector).toBe('global');
    });

    test('cleanBreak: true returns the summary text and stopReason loop-break', async () => {
      let callCount = 0;
      const strategy: ToolCallingStrategy = {
        async chat(_messages, _opts) {
          callCount++;
          // First 4 calls return the same tool call to trigger the repeat detector.
          if (callCount <= 4) {
            return { content: '', toolCalls: [makeToolCall('test_tool')] };
          }
          // Final summarization round returns text.
          return { content: 'Here is what I found so far.' };
        },
      };

      const result = await runToolLoop(
        strategy,
        [{ role: 'user', content: 'work' }],
        {
          maxRounds: 10,
          tools: [dummyTool],
          toolExecutor: async () => ({ success: true, content: 'ok' }),
          logger: noopLogger,
          loopDetector: createLoopDetector(10),
          cleanBreak: true,
        },
        {}
      );

      expect(result.text).toBe('Here is what I found so far.');
      expect(result.stopReason).toBe('loop-break');
    });

    test('cleanBreak: true falls back to a canned sentence when the summary round is empty', async () => {
      let callCount = 0;
      const strategy: ToolCallingStrategy = {
        async chat(_messages, _opts) {
          callCount++;
          if (callCount <= 4) {
            return { content: '', toolCalls: [makeToolCall('test_tool')] };
          }
          // Even when the summary round succeeds, return empty content.
          return { content: '' };
        },
      };

      const result = await runToolLoop(
        strategy,
        [{ role: 'user', content: 'work' }],
        {
          maxRounds: 10,
          tools: [dummyTool],
          toolExecutor: async () => ({ success: true, content: 'ok' }),
          logger: noopLogger,
          loopDetector: createLoopDetector(10),
          cleanBreak: true,
        },
        {}
      );

      expect(result.text).not.toBe('');
      expect(result.text).toContain('continue');
    });

    test('cleanBreak: true accumulates usage from the summarization round', async () => {
      let callCount = 0;
      const strategy: ToolCallingStrategy = {
        async chat(_messages, _opts) {
          callCount++;
          if (callCount <= 4) {
            return {
              content: '',
              toolCalls: [makeToolCall('test_tool')],
              usage: {
                model: 'm',
                promptTokens: 5,
                completionTokens: 5,
                totalTokens: 10,
              },
            };
          }
          return {
            content: 'Summary',
            usage: {
              model: 'm',
              promptTokens: 3,
              completionTokens: 3,
              totalTokens: 6,
            },
          };
        },
      };

      const result = await runToolLoop(
        strategy,
        [{ role: 'user', content: 'work' }],
        {
          maxRounds: 10,
          tools: [dummyTool],
          toolExecutor: async () => ({ success: true, content: 'ok' }),
          logger: noopLogger,
          loopDetector: createLoopDetector(10),
          cleanBreak: true,
        },
        {}
      );

      expect(result.usage?.totalTokens).toBe(46);
    });

    test('without cleanBreak the legacy marker is preserved', async () => {
      const strategy: ToolCallingStrategy = {
        async chat(_messages, _opts) {
          return { content: '', toolCalls: [makeToolCall()] };
        },
      };

      const result = await runToolLoop(
        strategy,
        [{ role: 'user', content: 'work' }],
        {
          maxRounds: 10,
          tools: [dummyTool],
          toolExecutor: async () => ({ success: true, content: 'ok' }),
          logger: noopLogger,
          loopDetector: createLoopDetector(10),
          // NOTE: cleanBreak intentionally not set
        },
        {}
      );

      expect(result.text).toContain('[Loop stopped:');
    });
  });

  describe('observability (loopContext + onLoopBreak)', () => {
    test('emits a structured warn with the loop context on break', async () => {
      const warnings: { msg: string; data: any }[] = [];
      const warnLogger = {
        ...noopLogger,
        warn: (data: any, msg: string) => warnings.push({ msg, data }),
      };

      const strategy: ToolCallingStrategy = {
        async chat(_messages, _opts) {
          return { content: '', toolCalls: [makeToolCall('test_tool')] };
        },
      };

      await runToolLoop(
        strategy,
        [{ role: 'user', content: 'work' }],
        {
          maxRounds: 10,
          tools: [dummyTool],
          toolExecutor: async () => ({ success: true, content: 'ok' }),
          logger: warnLogger as any,
          loopDetector: createLoopDetector(10),
          loopContext: { botId: 'bot1', conversationId: 'conv1', caller: 'web-conversation' },
        },
        {}
      );

      const breakWarn = warnings.find((w) => w.msg.includes('Tool loop detector: breaking'));
      expect(breakWarn).toBeDefined();
      expect(breakWarn?.data).toMatchObject({
        botId: 'bot1',
        conversationId: 'conv1',
        caller: 'web-conversation',
        round: expect.any(Number),
        totalCalls: expect.any(Number),
        detector: expect.any(String),
        message: expect.any(String),
      });
    });

    test('invokes onLoopBreak once with the same payload', async () => {
      const strategy: ToolCallingStrategy = {
        async chat(_messages, _opts) {
          return { content: '', toolCalls: [makeToolCall('test_tool')] };
        },
      };

      const calls: any[] = [];
      await runToolLoop(
        strategy,
        [{ role: 'user', content: 'work' }],
        {
          maxRounds: 10,
          tools: [dummyTool],
          toolExecutor: async () => ({ success: true, content: 'ok' }),
          logger: noopLogger,
          loopDetector: createLoopDetector(10),
          loopContext: { botId: 'bot1', caller: 'webGenerate' },
          onLoopBreak: (info) => calls.push(info),
        },
        {}
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        botId: 'bot1',
        caller: 'webGenerate',
        round: expect.any(Number),
        totalCalls: expect.any(Number),
        detector: expect.any(String),
        message: expect.any(String),
      });
    });

    test('does not throw when onLoopBreak is not provided', async () => {
      const strategy: ToolCallingStrategy = {
        async chat(_messages, _opts) {
          return { content: '', toolCalls: [makeToolCall('test_tool')] };
        },
      };

      await expect(
        runToolLoop(
          strategy,
          [{ role: 'user', content: 'work' }],
          {
            maxRounds: 10,
            tools: [dummyTool],
            toolExecutor: async () => ({ success: true, content: 'ok' }),
            logger: noopLogger,
            loopDetector: createLoopDetector(10),
            // no onLoopBreak, no loopContext
          },
          {}
        )
      ).resolves.toBeDefined();
    });

    test('does not fail the reply when onLoopBreak throws', async () => {
      const strategy: ToolCallingStrategy = {
        async chat(_messages, _opts) {
          return { content: '', toolCalls: [makeToolCall('test_tool')] };
        },
      };

      const result = await runToolLoop(
        strategy,
        [{ role: 'user', content: 'work' }],
        {
          maxRounds: 10,
          tools: [dummyTool],
          toolExecutor: async () => ({ success: true, content: 'ok' }),
          logger: noopLogger,
          loopDetector: createLoopDetector(10),
          onLoopBreak: () => {
            throw new Error('listener boom');
          },
        },
        {}
      );

      expect(result.text).toContain('[Loop stopped:');
    });
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

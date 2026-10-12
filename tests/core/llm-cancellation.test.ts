import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ProviderCooldownTracker } from '../../src/bot/model-failover';
import { LLMAbortedError } from '../../src/core/abort';
import {
  FailoverLLMClient,
  type LLMChatOptions,
  type LLMClient,
  LLMClientWithFallback,
  type LLMResponse,
} from '../../src/core/llm-client';
import { type ToolCallingStrategy, runToolLoop } from '../../src/core/tool-runner';
import { type ChatMessage, OllamaClient } from '../../src/ollama';
import type { ToolDefinition } from '../../src/tools/types';

function logger() {
  return { info: mock(), warn: mock(), error: mock(), debug: mock() } as any;
}

const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: { name: 't', description: 't', parameters: { type: 'object', properties: {} } },
  },
];

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('runToolLoop cancellation', () => {
  test('aborted before the first round: no LLM call, rejects with LLMAbortedError', async () => {
    const chat = mock(async () => ({ content: 'x' }));
    const ac = new AbortController();
    ac.abort();
    await expect(
      runToolLoop(
        { chat },
        msgs,
        { maxRounds: 3, tools, toolExecutor: mock(), logger: logger() },
        { signal: ac.signal }
      )
    ).rejects.toBeInstanceOf(LLMAbortedError);
    expect(chat).not.toHaveBeenCalled();
  });

  test('abort during a tool stops before the next tool and the next round', async () => {
    const ac = new AbortController();
    const strategy: ToolCallingStrategy = {
      chat: mock(async () => ({
        content: '',
        toolCalls: [
          { function: { name: 't', arguments: { n: 1 } } },
          { function: { name: 't', arguments: { n: 2 } } },
        ],
      })),
    };
    const executor = mock(async () => {
      ac.abort();
      return { success: true, content: 'done' };
    });
    await expect(
      runToolLoop(
        strategy,
        msgs,
        { maxRounds: 3, tools, toolExecutor: executor, logger: logger() },
        { signal: ac.signal }
      )
    ).rejects.toBeInstanceOf(LLMAbortedError);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(strategy.chat).toHaveBeenCalledTimes(1);
  });
});

describe('OllamaClient: abort never falls back', () => {
  function client() {
    return new OllamaClient(
      {
        baseUrl: 'http://ollama.test',
        timeout: 30_000,
        models: { primary: 'p', fallbacks: ['f1', 'f2'] },
      } as any,
      logger()
    );
  }

  test('chat with tools: abort mid-loop rejects without trying fallback models or replaying tools', async () => {
    const ac = new AbortController();
    const models: string[] = [];
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      models.push(body.model);
      // The request carries the caller's signal (combined with the timeout).
      expect(init?.signal).toBeDefined();
      return Response.json({
        model: body.model,
        message: { content: '', tool_calls: [{ function: { name: 't', arguments: {} } }] },
      });
    }) as any;
    const executor = mock(async () => {
      ac.abort();
      return { success: true, content: 'r' };
    });
    await expect(
      client().chat(msgs, { tools, toolExecutor: executor, signal: ac.signal })
    ).rejects.toBeInstanceOf(LLMAbortedError);
    expect(models).toEqual(['p']);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  test('chat: the caller signal aborts the in-flight fetch, no fallback', async () => {
    const ac = new AbortController();
    const models: string[] = [];
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      models.push(JSON.parse(String(init?.body)).model);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      });
    }) as any;
    const pending = client().chat(msgs, { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(pending).rejects.toBeInstanceOf(LLMAbortedError);
    expect(models).toEqual(['p']);
  });

  test('generate: abort skips fallbacks', async () => {
    const ac = new AbortController();
    const models: string[] = [];
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      models.push(JSON.parse(String(init?.body)).model);
      ac.abort();
      throw new Error('fetch failed');
    }) as any;
    await expect(client().generate('x', { signal: ac.signal })).rejects.toBeInstanceOf(
      LLMAbortedError
    );
    expect(models).toEqual(['p']);
  });

  test('without a signal, a failure still tries fallback models', async () => {
    const models: string[] = [];
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model;
      models.push(model);
      if (model === 'p') throw new Error('boom');
      return Response.json({ model, message: { content: 'ok' } });
    }) as any;
    const res = await client().chat(msgs);
    expect(res.text).toBe('ok');
    expect(models).toEqual(['p', 'f1']);
  });
});

function fakeClient(
  backend: 'ollama' | 'claude-cli',
  impl: (opts?: LLMChatOptions) => Promise<LLMResponse>
): LLMClient & { chat: ReturnType<typeof mock>; generate: ReturnType<typeof mock> } {
  return {
    backend,
    chat: mock((_m: ChatMessage[], opts?: LLMChatOptions) => impl(opts)),
    generate: mock((_p: string, opts?: LLMChatOptions) => impl(opts)),
  };
}

describe('LLMClientWithFallback: abort never crosses backends', () => {
  test('chat: an aborted signal rethrows without calling the fallback', async () => {
    const ac = new AbortController();
    const primary = fakeClient('claude-cli', async () => {
      ac.abort();
      throw new Error('Claude CLI failed (exit 143)');
    });
    const fallback = fakeClient('ollama', async () => ({ text: 'replayed' }));
    const wrapper = new LLMClientWithFallback(primary, fallback, logger());
    const onFallback = mock();
    wrapper.onFallback = onFallback;
    await expect(wrapper.chat(msgs, { signal: ac.signal })).rejects.toBeInstanceOf(LLMAbortedError);
    expect(fallback.chat).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  test('generate: an abort error rethrows without calling the fallback', async () => {
    const primary = fakeClient('claude-cli', async () => {
      throw new LLMAbortedError();
    });
    const fallback = fakeClient('ollama', async () => ({ text: 'replayed' }));
    const wrapper = new LLMClientWithFallback(primary, fallback, logger());
    await expect(wrapper.generate('x')).rejects.toBeInstanceOf(LLMAbortedError);
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  test('forwards the signal to the primary', async () => {
    const ac = new AbortController();
    const primary = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    const wrapper = new LLMClientWithFallback(
      primary,
      fakeClient('ollama', async () => ({ text: '' })),
      logger()
    );
    await wrapper.chat(msgs, { signal: ac.signal });
    expect(primary.chat.mock.calls[0][1].signal).toBe(ac.signal);
  });
});

describe('FailoverLLMClient: abort stops the candidate chain', () => {
  function failover(primary: LLMClient, secondary: LLMClient) {
    return new FailoverLLMClient(
      primary,
      secondary,
      logger(),
      [
        { backend: 'claude-cli', model: 'c' },
        { backend: 'ollama', model: 'o' },
      ],
      new ProviderCooldownTracker()
    );
  }

  test('chat: abort after the first candidate fails never tries the next', async () => {
    const ac = new AbortController();
    const primary = fakeClient('claude-cli', async () => {
      ac.abort();
      throw new Error('Claude CLI failed (exit 143)');
    });
    const secondary = fakeClient('ollama', async () => ({ text: 'replayed' }));
    await expect(
      failover(primary, secondary).chat(msgs, { signal: ac.signal })
    ).rejects.toBeInstanceOf(LLMAbortedError);
    expect(secondary.chat).not.toHaveBeenCalled();
  });

  test('generate: already aborted → no candidate runs', async () => {
    const ac = new AbortController();
    ac.abort();
    const primary = fakeClient('claude-cli', async () => ({ text: 'x' }));
    const secondary = fakeClient('ollama', async () => ({ text: 'x' }));
    await expect(
      failover(primary, secondary).generate('x', { signal: ac.signal })
    ).rejects.toBeInstanceOf(LLMAbortedError);
    expect(primary.generate).not.toHaveBeenCalled();
    expect(secondary.generate).not.toHaveBeenCalled();
  });

  test('passes the signal down to the candidate', async () => {
    const ac = new AbortController();
    const primary = fakeClient('claude-cli', async () => ({ text: 'ok' }));
    await failover(
      primary,
      fakeClient('ollama', async () => ({ text: '' }))
    ).chat(msgs, {
      signal: ac.signal,
    });
    expect(primary.chat.mock.calls[0][1].signal).toBe(ac.signal);
  });
});

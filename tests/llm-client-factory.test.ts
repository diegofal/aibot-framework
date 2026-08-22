import { describe, expect, mock, test } from 'bun:test';
import type { ModelCandidate } from '../src/bot/model-failover';
import {
  ClaudeCliLLMClient,
  FailoverLLMClient,
  LLMClientWithFallback,
  OllamaLLMClient,
  createLLMClient,
  orderCandidatesByBackend,
  resolveOllamaModels,
} from '../src/core/llm-client';
import type { OllamaClient } from '../src/ollama';

function mockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  } as any;
}

/** Minimal stand-in for OllamaClient carrying a realistic model config. */
function mockOllama(primary = 'qwen3:8b', fallbacks: string[] = ['llama3.1:8b']): OllamaClient {
  return {
    config: { models: { primary, fallbacks } },
    generate: mock(() => Promise.resolve({ text: 'ollama' })),
    chat: mock(() => Promise.resolve({ text: 'ollama' })),
  } as unknown as OllamaClient;
}

function candidatesOf(client: unknown): ModelCandidate[] {
  return (client as { candidates: ModelCandidate[] }).candidates;
}

describe('resolveOllamaModels', () => {
  test('reads the configured primary + fallbacks off the client', () => {
    expect(resolveOllamaModels(mockOllama('qwen3:8b', ['llama3.1:8b']), {})).toEqual({
      primary: 'qwen3:8b',
      fallbacks: ['llama3.1:8b'],
    });
  });

  test('an explicit ollamaModel option wins over the client config', () => {
    expect(resolveOllamaModels(mockOllama('qwen3:8b'), { ollamaModel: 'gemma3:12b' }).primary).toBe(
      'gemma3:12b'
    );
  });

  test('never yields a stringified object (the [object Object] bug)', () => {
    const models = resolveOllamaModels(mockOllama(), {});
    expect(models.primary).not.toContain('object Object');
  });

  test('tolerates a client with no readable model config', () => {
    expect(resolveOllamaModels({} as unknown as OllamaClient, {})).toEqual({
      primary: undefined,
      fallbacks: undefined,
    });
  });
});

describe('orderCandidatesByBackend', () => {
  const chain: ModelCandidate[] = [
    { backend: 'ollama', model: 'qwen3:8b' },
    { backend: 'ollama', model: 'llama3.1:8b' },
    { backend: 'claude-cli', model: 'sonnet' },
  ];

  test('puts the claude-cli candidates first for a claude-cli bot', () => {
    const ordered = orderCandidatesByBackend(chain, 'claude-cli');
    expect(ordered[0]).toEqual({ backend: 'claude-cli', model: 'sonnet' });
    expect(ordered).toHaveLength(3);
  });

  test('puts the ollama candidates first for an ollama bot', () => {
    const ordered = orderCandidatesByBackend(chain, 'ollama');
    expect(ordered[0]).toEqual({ backend: 'ollama', model: 'qwen3:8b' });
    expect(ordered[2]).toEqual({ backend: 'claude-cli', model: 'sonnet' });
  });

  test('is a stable partition — relative order within a backend is preserved', () => {
    const ordered = orderCandidatesByBackend(chain, 'claude-cli');
    expect(ordered.map((c) => c.model)).toEqual(['sonnet', 'qwen3:8b', 'llama3.1:8b']);
  });

  test('returns the chain untouched when the backend is absent from it', () => {
    const onlyOllama: ModelCandidate[] = [{ backend: 'ollama', model: 'qwen3:8b' }];
    expect(orderCandidatesByBackend(onlyOllama, 'claude-cli')).toEqual(onlyOllama);
  });

  test('handles an empty chain', () => {
    expect(orderCandidatesByBackend([], 'ollama')).toEqual([]);
  });
});

describe('createLLMClient — cross-backend fallback is opt-in', () => {
  test('claude-cli returns a bare client by default, with no route to ollama', () => {
    const client = createLLMClient({ llmBackend: 'claude-cli' }, mockOllama(), mockLogger());

    expect(client).toBeInstanceOf(ClaudeCliLLMClient);
    expect(client).not.toBeInstanceOf(LLMClientWithFallback);
    expect(client.backend).toBe('claude-cli');
    expect(client.getBackendClient?.('ollama')).toBeUndefined();
  });

  test('crossBackendFallback: true restores the wrapper', () => {
    const client = createLLMClient(
      { llmBackend: 'claude-cli', crossBackendFallback: true },
      mockOllama(),
      mockLogger()
    );

    expect(client).toBeInstanceOf(LLMClientWithFallback);
    expect(client.backend).toBe('claude-cli');
    expect(client.getBackendClient?.('ollama')).toBeInstanceOf(OllamaLLMClient);
  });

  test('the ollama path is unchanged', () => {
    const client = createLLMClient({ llmBackend: 'ollama' }, mockOllama(), mockLogger());
    expect(client).toBeInstanceOf(OllamaLLMClient);
    expect(client.backend).toBe('ollama');
  });

  test('defaults to ollama when no backend is given', () => {
    const client = createLLMClient({}, mockOllama(), mockLogger());
    expect(client).toBeInstanceOf(OllamaLLMClient);
  });
});

describe('createLLMClient — failover candidate chain', () => {
  const failoverConfig = { enabled: true };

  test('a claude-cli bot gets claude-cli first in the chain', () => {
    const client = createLLMClient(
      { llmBackend: 'claude-cli', claudeModel: 'sonnet', failoverConfig },
      mockOllama(),
      mockLogger()
    );

    expect(client).toBeInstanceOf(FailoverLLMClient);
    expect(candidatesOf(client)[0].backend).toBe('claude-cli');
    expect(client.backend).toBe('claude-cli');
  });

  test('an ollama bot gets ollama first in the chain', () => {
    const client = createLLMClient(
      { llmBackend: 'ollama', claudeModel: 'sonnet', failoverConfig },
      mockOllama('qwen3:8b'),
      mockLogger()
    );

    expect(client).toBeInstanceOf(FailoverLLMClient);
    expect(candidatesOf(client)[0]).toEqual({ backend: 'ollama', model: 'qwen3:8b' });
    expect(client.backend).toBe('ollama');
  });

  test('the ollama candidate carries the real configured model, not a stringified client', () => {
    const client = createLLMClient(
      { llmBackend: 'claude-cli', claudeModel: 'sonnet', failoverConfig },
      mockOllama('qwen3:8b', ['llama3.1:8b']),
      mockLogger()
    );

    const models = candidatesOf(client)
      .filter((c) => c.backend === 'ollama')
      .map((c) => c.model);
    expect(models).toContain('qwen3:8b');
    expect(models.join(',')).not.toContain('object Object');
  });

  test('failover wins over crossBackendFallback: false', () => {
    const client = createLLMClient(
      {
        llmBackend: 'claude-cli',
        claudeModel: 'sonnet',
        failoverConfig,
        crossBackendFallback: false,
      },
      mockOllama(),
      mockLogger()
    );
    expect(client).toBeInstanceOf(FailoverLLMClient);
  });

  test('an explicit candidate list is still reordered to put the bot backend first', () => {
    const client = createLLMClient(
      {
        llmBackend: 'claude-cli',
        claudeModel: 'sonnet',
        failoverConfig: {
          enabled: true,
          candidates: [
            { backend: 'ollama', model: 'qwen3:8b' },
            { backend: 'claude-cli', model: 'sonnet' },
          ],
        },
      },
      mockOllama(),
      mockLogger()
    );

    expect(candidatesOf(client)[0].backend).toBe('claude-cli');
  });

  test('a single-candidate chain falls back to the non-failover path', () => {
    const client = createLLMClient(
      {
        llmBackend: 'claude-cli',
        failoverConfig: {
          enabled: true,
          candidates: [{ backend: 'claude-cli', model: 'sonnet' }],
        },
      },
      mockOllama(),
      mockLogger()
    );
    expect(client).not.toBeInstanceOf(FailoverLLMClient);
    expect(client).toBeInstanceOf(ClaudeCliLLMClient);
  });
});

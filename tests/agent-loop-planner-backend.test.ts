import { describe, expect, mock, test } from 'bun:test';
import {
  resolvePlannerBackend,
  resolvePlannerModel,
  selectPlannerClient,
} from '../src/bot/agent-planner';
import { BotAgentLoopOverrideSchema, GlobalAgentLoopConfigSchema } from '../src/config';
import {
  ClaudeCliLLMClient,
  FailoverLLMClient,
  type LLMClient,
  LLMClientWithFallback,
  OllamaLLMClient,
} from '../src/core/llm-client';

function mockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(() => mockLogger()),
  } as any;
}

function bareClient(backend: 'ollama' | 'claude-cli', text = 'ok'): LLMClient & { generate: any } {
  const client = {
    backend,
    generate: mock(() => Promise.resolve({ text })),
    chat: mock(() => Promise.resolve({ text })),
    getBackendClient(b: 'ollama' | 'claude-cli') {
      return b === backend ? client : undefined;
    },
  };
  return client;
}

const config = {
  ollama: { models: { primary: 'glm-5.2:cloud' } },
  claudeCli: { model: 'claude-sonnet-4' },
};

describe('agentLoop.plannerBackend config', () => {
  test('global default is inherit', () => {
    const parsed = GlobalAgentLoopConfigSchema.parse({});
    expect(parsed.plannerBackend).toBe('inherit');
  });

  test('global accepts explicit ollama / claude-cli', () => {
    expect(GlobalAgentLoopConfigSchema.parse({ plannerBackend: 'ollama' }).plannerBackend).toBe(
      'ollama'
    );
    expect(GlobalAgentLoopConfigSchema.parse({ plannerBackend: 'claude-cli' }).plannerBackend).toBe(
      'claude-cli'
    );
  });

  test('per-bot override is optional and validated', () => {
    expect(BotAgentLoopOverrideSchema.parse({}).plannerBackend).toBeUndefined();
    expect(BotAgentLoopOverrideSchema.parse({ plannerBackend: 'ollama' }).plannerBackend).toBe(
      'ollama'
    );
    expect(() => BotAgentLoopOverrideSchema.parse({ plannerBackend: 'openai' })).toThrow();
  });
});

describe('resolvePlannerBackend', () => {
  test('inherit follows the bot backend (claude-cli)', () => {
    expect(
      resolvePlannerBackend({ plannerBackend: 'inherit' }, { llmBackend: 'claude-cli' } as any)
    ).toBe('claude-cli');
  });

  test('inherit with no bot backend defaults to ollama', () => {
    expect(resolvePlannerBackend({ plannerBackend: 'inherit' }, {} as any)).toBe('ollama');
  });

  test('global explicit ollama overrides the bot backend', () => {
    expect(
      resolvePlannerBackend({ plannerBackend: 'ollama' }, { llmBackend: 'claude-cli' } as any)
    ).toBe('ollama');
  });

  test('per-bot setting wins over global', () => {
    expect(
      resolvePlannerBackend({ plannerBackend: 'ollama' }, {
        llmBackend: 'claude-cli',
        agentLoop: { plannerBackend: 'inherit' },
      } as any)
    ).toBe('claude-cli');
    expect(
      resolvePlannerBackend({ plannerBackend: 'inherit' }, {
        llmBackend: 'ollama',
        agentLoop: { plannerBackend: 'claude-cli' },
      } as any)
    ).toBe('claude-cli');
  });

  test('missing global setting behaves as inherit', () => {
    expect(resolvePlannerBackend({}, { llmBackend: 'claude-cli' } as any)).toBe('claude-cli');
  });
});

describe('resolvePlannerModel', () => {
  test('keeps the bot active model when the planner backend matches the bot backend', () => {
    expect(
      resolvePlannerModel('claude-cli', { llmBackend: 'claude-cli' } as any, config, 'claude-x')
    ).toBe('claude-x');
    expect(resolvePlannerModel('ollama', { llmBackend: 'ollama' } as any, config, 'qwen')).toBe(
      'qwen'
    );
  });

  test('claude-cli bot routed to ollama uses the ollama primary model (never "claude")', () => {
    expect(
      resolvePlannerModel('ollama', { llmBackend: 'claude-cli' } as any, config, 'claude')
    ).toBe('glm-5.2:cloud');
  });

  test('ollama bot routed to claude-cli uses claudeCli.model, falling back to "claude"', () => {
    expect(resolvePlannerModel('claude-cli', { llmBackend: 'ollama' } as any, config, 'qwen')).toBe(
      'claude-sonnet-4'
    );
    expect(
      resolvePlannerModel(
        'claude-cli',
        { llmBackend: 'ollama' } as any,
        { ollama: { models: { primary: 'qwen' } } },
        'qwen'
      )
    ).toBe('claude');
  });
});

describe('LLMClient.getBackendClient', () => {
  test('bare clients return themselves only for their own backend', () => {
    const ollama = new OllamaLLMClient({} as any);
    expect(ollama.getBackendClient('ollama')).toBe(ollama);
    expect(ollama.getBackendClient('claude-cli')).toBeUndefined();

    const claude = new ClaudeCliLLMClient('claude', 1000, mockLogger());
    expect(claude.getBackendClient('claude-cli')).toBe(claude);
    expect(claude.getBackendClient('ollama')).toBeUndefined();
  });

  test('LLMClientWithFallback unwraps the bare primary and fallback', () => {
    const primary = bareClient('claude-cli');
    const fallback = bareClient('ollama');
    const wrapped = new LLMClientWithFallback(primary, fallback, mockLogger());
    expect(wrapped.getBackendClient('claude-cli')).toBe(primary);
    expect(wrapped.getBackendClient('ollama')).toBe(fallback);
  });

  test('FailoverLLMClient unwraps the bare primary and fallback', () => {
    const primary = bareClient('claude-cli');
    const fallback = bareClient('ollama');
    const wrapped = new FailoverLLMClient(
      primary,
      fallback,
      mockLogger(),
      [{ backend: 'claude-cli' }, { backend: 'ollama', model: 'x' }],
      undefined as any
    );
    expect(wrapped.getBackendClient('claude-cli')).toBe(primary);
    expect(wrapped.getBackendClient('ollama')).toBe(fallback);
  });
});

describe('selectPlannerClient', () => {
  test('claude-cli bot (inherit) gets the bare claude client — no silent ollama fallback', async () => {
    const primary = bareClient('claude-cli', 'from-claude');
    const fallback = bareClient('ollama', 'from-ollama');
    const wrapped = new LLMClientWithFallback(primary, fallback, mockLogger());

    const selected = selectPlannerClient(wrapped, 'claude-cli', {});
    expect(selected).toBe(primary);

    // A claude failure must surface instead of being swallowed by the wrapper
    primary.generate = mock(() => Promise.reject(new Error('Claude CLI exited with code 1')));
    await expect(selected.generate('p')).rejects.toThrow('Claude CLI exited');
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  test('explicit ollama on a claude-cli bot uses the bare ollama client', () => {
    const primary = bareClient('claude-cli');
    const fallback = bareClient('ollama');
    const wrapped = new LLMClientWithFallback(primary, fallback, mockLogger());
    expect(selectPlannerClient(wrapped, 'ollama', {})).toBe(fallback);
  });

  test('ollama bot asking for claude-cli uses the factory', () => {
    const ollama = bareClient('ollama');
    const made = bareClient('claude-cli');
    const createClaudeClient = mock(() => made);
    expect(selectPlannerClient(ollama, 'claude-cli', { createClaudeClient })).toBe(made);
    expect(createClaudeClient).toHaveBeenCalledTimes(1);
  });

  test('falls back to the bot client (with a warning) when the backend cannot be built', () => {
    const ollama = bareClient('ollama');
    const logger = mockLogger();
    expect(selectPlannerClient(ollama, 'claude-cli', { logger })).toBe(ollama);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('clients without getBackendClient are used as-is when the backend matches', () => {
    const legacy = { backend: 'ollama', generate: mock(), chat: mock() } as unknown as LLMClient;
    expect(selectPlannerClient(legacy, 'ollama', {})).toBe(legacy);
  });
});

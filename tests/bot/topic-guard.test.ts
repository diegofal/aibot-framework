import { describe, expect, test } from 'bun:test';
import { TopicGuard, type TopicGuardConfig } from '../../src/bot/topic-guard';

// Mock BotContext
function createMockCtx(llmResponse: string, shouldError = false, delayMs = 0) {
  return {
    getLLMClient: () => ({
      generate: async () => {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (shouldError) throw new Error('LLM error');
        return { text: llmResponse };
      },
      backend: 'claude-cli' as const,
    }),
  } as any;
}

function createMockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as any;
}

const baseConfig: TopicGuardConfig = {
  enabled: true,
  botPurpose: 'Sales coaching for B2B teams',
  allowedTopics: ['sales', 'negotiation', 'pipeline'],
  strictness: 'moderate',
  failOpen: true,
};

describe('TopicGuard', () => {
  test('on-topic message is allowed', async () => {
    const ctx = createMockCtx('{"on_topic": true, "reason": "about sales"}');
    const guard = new TopicGuard(ctx);
    const result = await guard.check(
      'How do I close a deal?',
      'bot1',
      baseConfig,
      createMockLogger()
    );
    expect(result.allowed).toBe(true);
  });

  test('off-topic message is blocked', async () => {
    const ctx = createMockCtx('{"on_topic": false, "reason": "cooking is unrelated"}');
    const guard = new TopicGuard(ctx);
    const result = await guard.check(
      'What is the recipe for pasta?',
      'bot1',
      baseConfig,
      createMockLogger()
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('cooking is unrelated');
  });

  test('very short messages are always allowed', async () => {
    const ctx = createMockCtx('should not be called');
    const guard = new TopicGuard(ctx);
    const result = await guard.check('hi', 'bot1', baseConfig, createMockLogger());
    expect(result.allowed).toBe(true);
  });

  test('fail-open on LLM error', async () => {
    const ctx = createMockCtx('', true);
    const guard = new TopicGuard(ctx);
    const result = await guard.check('Some message here', 'bot1', baseConfig, createMockLogger());
    expect(result.allowed).toBe(true);
  });

  test('fail-closed when failOpen is false', async () => {
    const ctx = createMockCtx('', true);
    const guard = new TopicGuard(ctx);
    const cfg = { ...baseConfig, failOpen: false };
    const result = await guard.check('Some message here', 'bot1', cfg, createMockLogger());
    expect(result.allowed).toBe(false);
  });

  test('timeout results in fail-open', async () => {
    const ctx = createMockCtx('{"on_topic": true}', false, 10000); // 10s delay
    const guard = new TopicGuard(ctx);
    const result = await guard.check(
      'A long question about something',
      'bot1',
      baseConfig,
      createMockLogger()
    );
    expect(result.allowed).toBe(true); // fail-open
  }, 10000); // Allow 10s for this test (internal 5s timeout + margin)

  test('custom reject message in config', async () => {
    const ctx = createMockCtx('{"on_topic": false, "reason": "off topic"}');
    const guard = new TopicGuard(ctx);
    const cfg = { ...baseConfig, customRejectMessage: 'Please ask about sales!' };
    const result = await guard.check('Tell me about cats', 'bot1', cfg, createMockLogger());
    expect(result.allowed).toBe(false);
  });

  test('handles non-JSON LLM response with yes', async () => {
    const ctx = createMockCtx('Yes, this is on topic.');
    const guard = new TopicGuard(ctx);
    const result = await guard.check(
      'How to negotiate better?',
      'bot1',
      baseConfig,
      createMockLogger()
    );
    expect(result.allowed).toBe(true);
  });

  test('handles non-JSON LLM response with no', async () => {
    const ctx = createMockCtx('No, this is about cooking.');
    const guard = new TopicGuard(ctx);
    const result = await guard.check(
      'Recipe for pancakes?',
      'bot1',
      baseConfig,
      createMockLogger()
    );
    expect(result.allowed).toBe(false);
  });

  test('uses default model when not specified', async () => {
    let capturedModel: string | undefined;
    const ctx = {
      getLLMClient: () => ({
        generate: async (_prompt: string, opts: any) => {
          capturedModel = opts.model;
          return { text: '{"on_topic": true, "reason": "ok"}' };
        },
        backend: 'claude-cli' as const,
      }),
    } as any;
    const guard = new TopicGuard(ctx);
    const cfg = { ...baseConfig, model: undefined };
    await guard.check('Some question', 'bot1', cfg, createMockLogger());
    expect(capturedModel).toBe('claude-haiku-4-5-20251001');
  });

  test('uses custom model when specified', async () => {
    let capturedModel: string | undefined;
    const ctx = {
      getLLMClient: () => ({
        generate: async (_prompt: string, opts: any) => {
          capturedModel = opts.model;
          return { text: '{"on_topic": true, "reason": "ok"}' };
        },
        backend: 'claude-cli' as const,
      }),
    } as any;
    const guard = new TopicGuard(ctx);
    const cfg = { ...baseConfig, model: 'custom-model' };
    await guard.check('Some question', 'bot1', cfg, createMockLogger());
    expect(capturedModel).toBe('custom-model');
  });

  test('prompt includes allowed topics', async () => {
    let capturedPrompt = '';
    const ctx = {
      getLLMClient: () => ({
        generate: async (prompt: string) => {
          capturedPrompt = prompt;
          return { text: '{"on_topic": true, "reason": "ok"}' };
        },
        backend: 'claude-cli' as const,
      }),
    } as any;
    const guard = new TopicGuard(ctx);
    await guard.check('Something', 'bot1', baseConfig, createMockLogger());
    expect(capturedPrompt).toContain('sales, negotiation, pipeline');
  });

  test('prompt includes blocked topics', async () => {
    let capturedPrompt = '';
    const ctx = {
      getLLMClient: () => ({
        generate: async (prompt: string) => {
          capturedPrompt = prompt;
          return { text: '{"on_topic": true, "reason": "ok"}' };
        },
        backend: 'claude-cli' as const,
      }),
    } as any;
    const guard = new TopicGuard(ctx);
    const cfg = { ...baseConfig, blockedTopics: ['politics', 'religion'] };
    await guard.check('Something', 'bot1', cfg, createMockLogger());
    expect(capturedPrompt).toContain('politics, religion');
  });

  test('strict mode uses strict instructions', async () => {
    let capturedPrompt = '';
    const ctx = {
      getLLMClient: () => ({
        generate: async (prompt: string) => {
          capturedPrompt = prompt;
          return { text: '{"on_topic": true, "reason": "ok"}' };
        },
        backend: 'claude-cli' as const,
      }),
    } as any;
    const guard = new TopicGuard(ctx);
    const cfg = { ...baseConfig, strictness: 'strict' as const };
    await guard.check('Something', 'bot1', cfg, createMockLogger());
    expect(capturedPrompt).toContain('Be strict');
  });

  test('loose mode uses lenient instructions', async () => {
    let capturedPrompt = '';
    const ctx = {
      getLLMClient: () => ({
        generate: async (prompt: string) => {
          capturedPrompt = prompt;
          return { text: '{"on_topic": true, "reason": "ok"}' };
        },
        backend: 'claude-cli' as const,
      }),
    } as any;
    const guard = new TopicGuard(ctx);
    const cfg = { ...baseConfig, strictness: 'loose' as const };
    await guard.check('Something', 'bot1', cfg, createMockLogger());
    expect(capturedPrompt).toContain('Be lenient');
  });
});

import { describe, expect, it } from 'bun:test';
import type { BotConfig, Config } from '../src/config';
import { resolveAgentConfig } from '../src/config';
import { resolveClaudeModel } from '../src/core/llm-client';

const globalConfig = {
  ollama: { models: { primary: 'qwen', fallbacks: [] } },
  claudeCli: { enabled: true, model: 'claude-opus-5' },
  conversation: { systemPrompt: '', temperature: 0.7, maxHistory: 20 },
  agentLoop: { enabled: false, every: '6h' },
  soul: { dir: './config/soul' },
  productions: { baseDir: './productions' },
  multiTenant: { dataDir: './data/tenants' },
} as unknown as Config;

describe('resolveClaudeModel', () => {
  it('uses the bot model only when the bot is on claude-cli', () => {
    expect(resolveClaudeModel({ llmBackend: 'claude-cli', model: 'opus' }, 'claude-opus-5')).toBe(
      'opus'
    );
    expect(resolveClaudeModel({ llmBackend: 'claude-cli' }, 'claude-opus-5')).toBe('claude-opus-5');
    expect(resolveClaudeModel({ llmBackend: 'ollama', model: 'qwen' }, 'claude-opus-5')).toBe(
      'claude-opus-5'
    );
    expect(resolveClaudeModel({ model: 'qwen' }, 'claude-opus-5')).toBe('claude-opus-5');
  });
  it('returns undefined when nothing is configured so the CLI picks its own default', () => {
    expect(resolveClaudeModel({ llmBackend: 'claude-cli' }, undefined)).toBeUndefined();
    expect(resolveClaudeModel({ llmBackend: 'claude-cli', model: null }, '')).toBeUndefined();
  });
});

describe('resolveAgentConfig with a per-bot Claude model', () => {
  it('keeps the pinned model for a claude-cli bot and falls back to claudeCli.model', () => {
    const pinned = { id: 'a', name: 'a', llmBackend: 'claude-cli', model: 'opus' } as BotConfig;
    expect(resolveAgentConfig(globalConfig, pinned).model).toBe('opus');
    const plain = { id: 'b', name: 'b', llmBackend: 'claude-cli' } as BotConfig;
    expect(resolveAgentConfig(globalConfig, plain).model).toBe('claude-opus-5');
  });
});

import { describe, expect, test } from 'bun:test';
import { resolveAgentConfig, resolveAgentConfigWithTenant } from '../src/config';

describe('resolveAgentConfigWithTenant', () => {
  const globalConfig = {
    ollama: { models: { primary: 'llama3', fallbacks: [] } },
    soul: { dir: './config/soul' },
    productions: { baseDir: './productions' },
    conversation: {
      systemPrompt: 'global prompt',
      temperature: 0.7,
      maxHistory: 50,
    },
  } as any;

  const botConfig = {
    id: 'bot-1',
    name: 'Bot 1',
    token: '',
    enabled: true,
    skills: [],
  } as any;

  test('without tenant config, behaves like resolveAgentConfig', () => {
    const result = resolveAgentConfigWithTenant(globalConfig, undefined, botConfig);
    const expected = resolveAgentConfig(globalConfig, botConfig);
    expect(result).toEqual(expected);
  });

  test('tenant config overrides global defaults', () => {
    const tenantConfig = {
      model: 'tenant-model',
      llmBackend: 'claude-cli',
      conversation: { temperature: 0.9 },
    };

    const result = resolveAgentConfigWithTenant(globalConfig, tenantConfig, botConfig);
    expect(result.model).toBe('tenant-model');
    expect(result.llmBackend).toBe('claude-cli');
    expect(result.temperature).toBe(0.9);
    // Global defaults still apply where tenant doesn't override
    expect(result.systemPrompt).toBe('global prompt');
    expect(result.maxHistory).toBe(50);
  });

  test('bot config overrides tenant config', () => {
    const tenantConfig = {
      model: 'tenant-model',
      llmBackend: 'claude-cli' as const,
      conversation: { temperature: 0.9, systemPrompt: 'tenant prompt' },
    };

    const botWithOverrides = {
      ...botConfig,
      model: 'bot-model',
      conversation: { temperature: 1.0 },
    };

    const result = resolveAgentConfigWithTenant(globalConfig, tenantConfig, botWithOverrides);
    expect(result.model).toBe('bot-model'); // bot wins
    expect(result.llmBackend).toBe('claude-cli'); // tenant (no bot override)
    expect(result.temperature).toBe(1.0); // bot wins
    expect(result.systemPrompt).toBe('tenant prompt'); // tenant (no bot override)
  });

  test('merge order: bot > tenant > global', () => {
    const tenantConfig = {
      conversation: { systemPrompt: 'tenant', temperature: 0.5, maxHistory: 100 },
    };

    const botWithPartial = {
      ...botConfig,
      conversation: { maxHistory: 200 },
    };

    const result = resolveAgentConfigWithTenant(globalConfig, tenantConfig, botWithPartial);
    expect(result.systemPrompt).toBe('tenant'); // tenant
    expect(result.temperature).toBe(0.5); // tenant
    expect(result.maxHistory).toBe(200); // bot wins
  });

  test('soulDir and workDir use data/ paths (not legacy config/soul/)', () => {
    const tenantConfig = { model: 'tenant-model' };
    const result = resolveAgentConfigWithTenant(globalConfig, tenantConfig, botConfig);
    expect(result.soulDir).toContain('__admin__/bots/bot-1/soul');
    expect(result.workDir).toBe('./productions/bot-1');
  });

  test('bot soulDir override still works with tenant config', () => {
    const tenantConfig = { model: 'tenant-model' };
    const botWithSoul = { ...botConfig, soulDir: '/custom/soul' };
    const result = resolveAgentConfigWithTenant(globalConfig, tenantConfig, botWithSoul);
    expect(result.soulDir).toBe('/custom/soul');
  });
});

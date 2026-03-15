import { describe, expect, test } from 'bun:test';
import { resolveAgentConfig, resolveAgentConfigWithTenant } from '../src/config';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    soul: {
      dir: './config/soul',
      enabled: true,
      search: {},
      memoryFlush: {},
      sessionMemory: {},
      versioning: {},
      healthCheck: {},
    },
    ollama: { baseUrl: 'http://localhost:11434', timeout: 300000, models: { primary: 'llama3' } },
    conversation: {
      enabled: true,
      systemPrompt: 'test',
      temperature: 0.7,
      maxHistory: 20,
      compaction: {},
    },
    productions: { enabled: true, baseDir: './productions' },
    claudeCli: { model: 'claude-sonnet-4-6' },
    multiTenant: { enabled: false, dataDir: './data/tenants' },
    ...overrides,
  } as unknown as import('../src/config').Config;
}

function makeBot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-bot',
    name: 'Test Bot',
    token: '',
    enabled: true,
    skills: [],
    disabledSkills: [],
    plan: 'free',
    ...overrides,
  } as unknown as import('../src/config').BotConfig;
}

describe('Soul Source Unification — resolveAgentConfig', () => {
  test('default soulDir resolves to data/tenants/__admin__/bots/{id}/soul', () => {
    const config = makeConfig();
    const bot = makeBot();
    const resolved = resolveAgentConfig(config, bot);
    expect(resolved.soulDir).toBe('./data/tenants/__admin__/bots/test-bot/soul');
  });

  test('explicit soulDir takes precedence', () => {
    const config = makeConfig();
    const bot = makeBot({ soulDir: '/custom/soul/path' });
    const resolved = resolveAgentConfig(config, bot);
    expect(resolved.soulDir).toBe('/custom/soul/path');
  });

  test('custom dataDir from multiTenant config is used', () => {
    const config = makeConfig({ multiTenant: { enabled: true, dataDir: './my-data' } });
    const bot = makeBot();
    const resolved = resolveAgentConfig(config, bot);
    expect(resolved.soulDir).toBe('./my-data/__admin__/bots/test-bot/soul');
  });

  test('soulDir no longer uses legacy config/soul/ path', () => {
    const config = makeConfig();
    const bot = makeBot();
    const resolved = resolveAgentConfig(config, bot);
    expect(resolved.soulDir).not.toContain('config/soul');
  });
});

describe('Soul Source Unification — resolveAgentConfigWithTenant', () => {
  test('tenant-scoped soulDir resolves to data/{tenant}/bots/{id}/soul', () => {
    const config = makeConfig();
    const bot = makeBot();
    const resolved = resolveAgentConfigWithTenant(config, undefined, bot, 'acme');
    expect(resolved.soulDir).toBe('./data/tenants/acme/bots/test-bot/soul');
  });

  test('non-tenant fallback uses __admin__ instead of config/soul/', () => {
    const config = makeConfig();
    const bot = makeBot();
    // tenantConfig provided but no tenantId
    const resolved = resolveAgentConfigWithTenant(config, {}, bot);
    expect(resolved.soulDir).toBe('./data/tenants/__admin__/bots/test-bot/soul');
  });

  test('no tenantConfig and no tenantId delegates to resolveAgentConfig', () => {
    const config = makeConfig();
    const bot = makeBot();
    const resolved = resolveAgentConfigWithTenant(config, undefined, bot);
    expect(resolved.soulDir).toBe('./data/tenants/__admin__/bots/test-bot/soul');
  });

  test('explicit soulDir overrides tenant-scoped path', () => {
    const config = makeConfig();
    const bot = makeBot({ soulDir: '/explicit/soul' });
    const resolved = resolveAgentConfigWithTenant(config, undefined, bot, 'acme');
    expect(resolved.soulDir).toBe('/explicit/soul');
  });
});

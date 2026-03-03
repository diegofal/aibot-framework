import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TenantConfigStore } from '../src/tenant/tenant-config-store';

describe('TenantConfigStore', () => {
  const tmpDir = join('/tmp', `tenant-config-test-${Date.now()}`);
  let store: TenantConfigStore;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    store = new TenantConfigStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('get returns default config when no file exists', () => {
    const config = store.get('tenant-1');
    expect(config.apiKeys).toEqual({});
    expect(config.conversation).toEqual({});
    expect(config.features).toEqual({
      agentLoop: true,
      productions: true,
      collaborations: true,
      tts: false,
    });
    expect(config.branding).toEqual({});
  });

  test('set and get roundtrip', () => {
    const config = store.get('tenant-1');
    config.llmBackend = 'claude-cli';
    config.model = 'claude-3-opus';
    config.conversation.temperature = 0.8;
    store.set('tenant-1', config);

    const loaded = store.get('tenant-1');
    expect(loaded.llmBackend).toBe('claude-cli');
    expect(loaded.model).toBe('claude-3-opus');
    expect(loaded.conversation.temperature).toBe(0.8);
  });

  test('update merges partial config', () => {
    store.set('tenant-1', {
      ...store.get('tenant-1'),
      model: 'existing-model',
      conversation: { temperature: 0.5 },
    });

    const updated = store.update('tenant-1', {
      llmBackend: 'claude-cli',
      conversation: { maxHistory: 100 },
    });

    expect(updated.model).toBe('existing-model'); // preserved
    expect(updated.llmBackend).toBe('claude-cli'); // added
    expect(updated.conversation.temperature).toBe(0.5); // preserved
    expect(updated.conversation.maxHistory).toBe(100); // added
  });

  test('exists returns false for unknown tenant', () => {
    expect(store.exists('unknown')).toBe(false);
  });

  test('exists returns true after set', () => {
    store.set('tenant-1', store.get('tenant-1'));
    expect(store.exists('tenant-1')).toBe(true);
  });

  test('setApiKeys and getApiKeys', () => {
    store.set('tenant-1', store.get('tenant-1'));

    store.setApiKeys('tenant-1', { claudeApiKey: 'sk-abc123' });
    const keys = store.getApiKeys('tenant-1');
    expect(keys.claudeApiKey).toBe('sk-abc123');
    expect(keys.elevenLabsApiKey).toBeUndefined();
  });

  test('setApiKeys preserves existing keys', () => {
    store.set('tenant-1', store.get('tenant-1'));
    store.setApiKeys('tenant-1', { claudeApiKey: 'sk-abc' });
    store.setApiKeys('tenant-1', { elevenLabsApiKey: 'el-xyz' });

    const keys = store.getApiKeys('tenant-1');
    expect(keys.claudeApiKey).toBe('sk-abc');
    expect(keys.elevenLabsApiKey).toBe('el-xyz');
  });

  test('creates directories recursively', () => {
    const deepDir = join(tmpDir, 'nested', 'deep');
    const deepStore = new TenantConfigStore(deepDir);
    deepStore.set('tenant-1', deepStore.get('tenant-1'));

    expect(existsSync(join(deepDir, 'tenant-1', 'config.json'))).toBe(true);
  });

  test('handles corrupt JSON gracefully', () => {
    const tenantDir = join(tmpDir, 'corrupt-tenant');
    mkdirSync(tenantDir, { recursive: true });
    const fs = require('node:fs');
    fs.writeFileSync(join(tenantDir, 'config.json'), 'NOT JSON!!!');

    const config = store.get('corrupt-tenant');
    // Should return defaults
    expect(config.apiKeys).toEqual({});
    expect(config.features.agentLoop).toBe(true);
  });

  test('different tenants have isolated configs', () => {
    store.set('tenant-a', { ...store.get('tenant-a'), model: 'model-a' });
    store.set('tenant-b', { ...store.get('tenant-b'), model: 'model-b' });

    expect(store.get('tenant-a').model).toBe('model-a');
    expect(store.get('tenant-b').model).toBe('model-b');
  });
});

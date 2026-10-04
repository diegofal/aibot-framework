import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TemplateService } from '../../src/tenant/template-service';

const TEST_DIR = join(import.meta.dir, '.tmp-template-test');

function makeLogger() {
  return {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeLogger(),
  } as any;
}

describe('TemplateService', () => {
  let service: TemplateService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new TemplateService(TEST_DIR, makeLogger());
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('create and get template', () => {
    const t = service.create(
      'Sales Bot',
      'A sales assistant',
      {
        name: 'SalesBot',
        conversation: { systemPrompt: 'You are a sales assistant.' },
        skills: ['reminders'],
      },
      'admin-tenant'
    );

    expect(t.id).toBeTruthy();
    expect(t.name).toBe('Sales Bot');
    expect(t.version).toBe(1);

    const fetched = service.get(t.id);
    expect(fetched).toBeDefined();
    expect(fetched?.config.name).toBe('SalesBot');
  });

  test('list templates', () => {
    service.create('T1', 'desc', { name: 'T1' }, 'admin');
    service.create('T2', 'desc', { name: 'T2' }, 'admin');

    expect(service.list()).toHaveLength(2);
  });

  test('update template bumps version when config changes', () => {
    const t = service.create('T1', 'desc', { name: 'T1' }, 'admin');
    expect(t.version).toBe(1);

    const updated = service.update(t.id, {
      config: { name: 'T1 Updated', conversation: { systemPrompt: 'New prompt' } },
    });
    expect(updated?.version).toBe(2);
  });

  test('update template without config does not bump version', () => {
    const t = service.create('T1', 'desc', { name: 'T1' }, 'admin');
    const updated = service.update(t.id, { name: 'Renamed' });
    expect(updated?.version).toBe(1);
  });

  test('delete template', () => {
    const t = service.create('T1', 'desc', { name: 'T1' }, 'admin');
    expect(service.delete(t.id)).toBe(true);
    expect(service.get(t.id)).toBeUndefined();
    expect(service.delete(t.id)).toBe(false);
  });

  test('instantiate creates BotConfig from template', () => {
    const t = service.create(
      'Sales',
      'desc',
      {
        name: 'SalesBot',
        model: 'gpt-4',
        conversation: { systemPrompt: 'Be helpful', temperature: 0.7 },
        skills: ['reminders'],
      },
      'admin'
    );

    const botConfig = service.instantiate(t.id, 'tenant-123', 'bot-abc', 'tok_secret');
    expect(botConfig).toBeDefined();
    expect(botConfig?.id).toBe('bot-abc');
    expect(botConfig?.tenantId).toBe('tenant-123');
    expect(botConfig?.token).toBe('tok_secret');
    expect(botConfig?.name).toBe('SalesBot');
    expect(botConfig?.model).toBe('gpt-4');
    expect(botConfig?.conversation?.systemPrompt).toBe('Be helpful');
    expect(botConfig?.skills).toEqual(['reminders']);
  });

  test('instantiate applies overrides', () => {
    const t = service.create(
      'Base',
      'desc',
      {
        name: 'BaseBot',
        model: 'gpt-4',
        conversation: { systemPrompt: 'Default prompt' },
      },
      'admin'
    );

    const botConfig = service.instantiate(t.id, 'tenant-123', 'bot-xyz', 'tok', {
      name: 'CustomBot',
      conversation: { systemPrompt: 'Custom prompt' },
    });
    expect(botConfig?.name).toBe('CustomBot');
    expect(botConfig?.conversation?.systemPrompt).toBe('Custom prompt');
  });

  test('instantiate returns undefined for missing template', () => {
    expect(service.instantiate('nonexistent', 't', 'b', 'tok')).toBeUndefined();
  });

  test('getInstance tracks template instance', () => {
    const t = service.create('T', 'd', { name: 'T' }, 'admin');
    service.instantiate(t.id, 'tenant-1', 'bot-1', 'tok');

    const inst = service.getInstance('bot-1');
    expect(inst).toBeDefined();
    expect(inst?.templateId).toBe(t.id);
    expect(inst?.tenantId).toBe('tenant-1');
    expect(inst?.templateVersion).toBe(1);
  });

  test('hasUpdate detects version mismatch', () => {
    const t = service.create('T', 'd', { name: 'T' }, 'admin');
    service.instantiate(t.id, 'tenant-1', 'bot-1', 'tok');

    expect(service.hasUpdate('bot-1')).toBe(false);

    service.update(t.id, { config: { name: 'T v2' } });
    expect(service.hasUpdate('bot-1')).toBe(true);
  });

  test('persistence across reloads', () => {
    const t = service.create('Persistent', 'desc', { name: 'P' }, 'admin');
    service.instantiate(t.id, 'tenant-1', 'bot-p', 'tok');

    // Create new instance (simulates restart)
    const service2 = new TemplateService(TEST_DIR, makeLogger());
    expect(service2.get(t.id)).toBeDefined();
    expect(service2.getInstance('bot-p')).toBeDefined();
  });

  test('extractTemplateConfig strips instance-specific fields', () => {
    const config = {
      id: 'bot-1',
      name: 'MyBot',
      token: 'secret',
      tenantId: 'tenant-1',
      enabled: true,
      model: 'gpt-4',
      skills: ['reminders'],
      conversation: { systemPrompt: 'Hello' },
    } as any;

    const extracted = TemplateService.extractTemplateConfig(config);
    expect(extracted.name).toBe('MyBot');
    expect(extracted.model).toBe('gpt-4');
    expect((extracted as any).id).toBeUndefined();
    expect((extracted as any).token).toBeUndefined();
    expect((extracted as any).tenantId).toBeUndefined();
  });
});

/**
 * Built-in templates (session S7): the agent presets are exposed to tenants as
 * read-only templates with stable ids. They live only in memory — never in
 * templates.json — and cannot be edited or deleted.
 */
describe('TemplateService built-in templates', () => {
  let service: TemplateService;
  const builtin = {
    id: 'preset:researcher',
    name: 'Scout',
    description: 'Researcher',
    config: { name: 'Scout', skills: ['reddit'], agentLoop: { every: '6h', mode: 'periodic' } },
  };

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new TemplateService(TEST_DIR, makeLogger());
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('registerBuiltin makes the template visible in get/list with a stable id and builtin flag', () => {
    const t = service.registerBuiltin(builtin);
    expect(t.id).toBe('preset:researcher');
    expect(t.builtin).toBe(true);
    expect(t.version).toBe(1);
    expect(t.createdBy).toBe('__builtin__');
    expect(service.get('preset:researcher')?.config.skills).toEqual(['reddit']);
    expect(service.list().map((x) => x.id)).toEqual(['preset:researcher']);
  });

  test('built-ins come first in list() and are never written to templates.json', () => {
    service.registerBuiltin(builtin);
    service.create('Mine', 'desc', { name: 'Mine' }, 'admin');
    const ids = service.list().map((x) => x.id);
    expect(ids[0]).toBe('preset:researcher');
    expect(ids).toHaveLength(2);
    const onDisk = JSON.parse(
      require('node:fs').readFileSync(join(TEST_DIR, 'templates.json'), 'utf-8')
    );
    expect(onDisk.templates.map((x: { id: string }) => x.id)).toEqual([ids[1]]);
    // A fresh service from the same dir does not carry the built-in until re-registered.
    const again = new TemplateService(TEST_DIR, makeLogger());
    expect(again.get('preset:researcher')).toBeUndefined();
  });

  test('built-ins refuse update and delete', () => {
    service.registerBuiltin(builtin);
    expect(service.update('preset:researcher', { name: 'X' })).toBeUndefined();
    expect(service.delete('preset:researcher')).toBe(false);
    expect(service.get('preset:researcher')?.name).toBe('Scout');
  });

  test('registering the same id twice replaces it; a user template cannot shadow a built-in', () => {
    service.registerBuiltin(builtin);
    service.registerBuiltin({ ...builtin, name: 'Scout v2' });
    expect(service.list()).toHaveLength(1);
    expect(service.get('preset:researcher')?.name).toBe('Scout v2');
  });

  test('instantiate works from a built-in and tracks the instance', () => {
    service.registerBuiltin(builtin);
    const bot = service.instantiate('preset:researcher', 'tenant-a', 'scout-1', 'tok');
    expect(bot?.id).toBe('scout-1');
    expect(bot?.skills).toEqual(['reddit']);
    expect(bot?.agentLoop).toEqual({ every: '6h', mode: 'periodic' });
    expect(service.getInstance('scout-1')?.templateId).toBe('preset:researcher');
  });
});

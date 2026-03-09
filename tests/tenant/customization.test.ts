import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CustomizationService } from '../../src/tenant/customization';

const TEST_DIR = join(import.meta.dir, '.tmp-customization-test');

function makeLogger() {
  return {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeLogger(),
  } as any;
}

describe('CustomizationService', () => {
  let service: CustomizationService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new CustomizationService(TEST_DIR, makeLogger());
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('set and get customization', () => {
    const c = service.set({
      tenantId: 'tenant-1',
      botId: 'bot-1',
      displayName: 'My Custom Bot',
      identityOverride: 'You are a friendly assistant for Acme Corp.',
      knowledge: ['Acme Corp was founded in 1990.'],
      goals: ['Help customers find products'],
      rules: ['Never discuss competitors'],
    });

    expect(c.updatedAt).toBeTruthy();
    expect(service.get('bot-1')).toBeDefined();
    expect(service.get('bot-1')?.displayName).toBe('My Custom Bot');
  });

  test("getForTenant returns only that tenant's customizations", () => {
    service.set({ tenantId: 'tenant-1', botId: 'bot-1', displayName: 'A' });
    service.set({ tenantId: 'tenant-2', botId: 'bot-2', displayName: 'B' });
    service.set({ tenantId: 'tenant-1', botId: 'bot-3', displayName: 'C' });

    expect(service.getForTenant('tenant-1')).toHaveLength(2);
    expect(service.getForTenant('tenant-2')).toHaveLength(1);
  });

  test('delete requires matching tenantId', () => {
    service.set({ tenantId: 'tenant-1', botId: 'bot-1' });
    expect(service.delete('bot-1', 'tenant-2')).toBe(false);
    expect(service.delete('bot-1', 'tenant-1')).toBe(true);
    expect(service.get('bot-1')).toBeUndefined();
  });

  test('composeOverlay returns undefined when no customization', () => {
    expect(service.composeOverlay('nonexistent')).toBeUndefined();
  });

  test('composeOverlay returns undefined when customization has no prompt fields', () => {
    service.set({ tenantId: 't', botId: 'b', displayName: 'Name Only' });
    expect(service.composeOverlay('b')).toBeUndefined();
  });

  test('composeOverlay builds structured prompt from all fields', () => {
    service.set({
      tenantId: 't',
      botId: 'b',
      identityOverride: 'You work for Acme.',
      knowledge: ['Acme makes widgets.', 'Acme HQ is in NYC.'],
      goals: ['Sell widgets', 'Retain customers'],
      rules: ['Be polite', 'Never lie'],
    });

    const overlay = service.composeOverlay('b');
    expect(overlay).toContain('## Identity');
    expect(overlay).toContain('You work for Acme.');
    expect(overlay).toContain('## Knowledge');
    expect(overlay).toContain('Acme makes widgets.');
    expect(overlay).toContain('## Goals');
    expect(overlay).toContain('1. Sell widgets');
    expect(overlay).toContain('2. Retain customers');
    expect(overlay).toContain('## Rules');
    expect(overlay).toContain('- Be polite');
  });

  // --- getTopicGuardOverlay tests ---

  test('getTopicGuardOverlay returns undefined when no customization and no bot config', () => {
    expect(service.getTopicGuardOverlay('nonexistent')).toBeUndefined();
  });

  test('getTopicGuardOverlay returns bot config when no tenant overlay', () => {
    const botConfig = {
      enabled: true,
      botPurpose: 'Sales coaching',
      allowedTopics: ['sales'],
      strictness: 'moderate' as const,
    };
    const result = service.getTopicGuardOverlay('no-overlay-bot', botConfig);
    expect(result).toEqual(botConfig);
  });

  test('getTopicGuardOverlay returns tenant overlay when no bot config', () => {
    service.set({
      tenantId: 't',
      botId: 'b',
      topicGuard: {
        enabled: true,
        botPurpose: 'Tenant purpose',
        allowedTopics: ['support'],
      },
    });
    const result = service.getTopicGuardOverlay('b');
    expect(result?.enabled).toBe(true);
    expect(result?.botPurpose).toBe('Tenant purpose');
    expect(result?.failOpen).toBe(true); // default when no bot config
  });

  test('getTopicGuardOverlay merges tenant overlay with bot config', () => {
    service.set({
      tenantId: 't',
      botId: 'b',
      topicGuard: {
        strictness: 'strict',
        allowedTopics: ['billing'],
        blockedTopics: ['politics'],
        customRejectMessage: 'Tenant reject',
      },
    });
    const botConfig = {
      enabled: true,
      botPurpose: 'Support bot',
      allowedTopics: ['support', 'account'],
      strictness: 'moderate' as const,
      failOpen: true,
    };
    const result = service.getTopicGuardOverlay('b', botConfig);
    expect(result?.enabled).toBe(true); // from bot
    expect(result?.botPurpose).toBe('Support bot'); // from bot (tenant didn't set)
    expect(result?.strictness).toBe('strict'); // tenant wins
    expect(result?.customRejectMessage).toBe('Tenant reject'); // tenant wins
    // Arrays are unioned
    expect(result?.allowedTopics).toContain('support');
    expect(result?.allowedTopics).toContain('account');
    expect(result?.allowedTopics).toContain('billing');
    expect(result?.blockedTopics).toContain('politics');
    expect(result?.failOpen).toBe(true); // from bot
  });

  test('getTopicGuardOverlay tenant can override enabled to false', () => {
    service.set({
      tenantId: 't',
      botId: 'b',
      topicGuard: { enabled: false },
    });
    const result = service.getTopicGuardOverlay('b', { enabled: true, botPurpose: 'test' });
    expect(result?.enabled).toBe(false);
  });

  test('persistence across reloads', () => {
    service.set({ tenantId: 't', botId: 'b', displayName: 'Persistent' });

    const service2 = new CustomizationService(TEST_DIR, makeLogger());
    expect(service2.get('b')?.displayName).toBe('Persistent');
  });
});

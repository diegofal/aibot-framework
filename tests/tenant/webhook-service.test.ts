import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type WebhookEventType, WebhookService } from '../../src/tenant/webhook-service';

const TEST_DIR = join(import.meta.dir, '.tmp-webhook-test');

function makeLogger() {
  return {
    info: () => {},
    debug: () => {},
    warn: mock(() => {}),
    error: () => {},
    child: () => makeLogger(),
  } as any;
}

describe('WebhookService', () => {
  let service: WebhookService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new WebhookService(TEST_DIR, makeLogger());
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('register creates a webhook with secret', () => {
    const reg = service.register('tenant-1', 'https://example.com/hook', ['message.sent']);

    expect(reg.id).toBeTruthy();
    expect(reg.tenantId).toBe('tenant-1');
    expect(reg.url).toBe('https://example.com/hook');
    expect(reg.events).toEqual(['message.sent']);
    expect(reg.secret).toMatch(/^whsec_/);
    expect(reg.enabled).toBe(true);
    expect(reg.failCount).toBe(0);
  });

  test("listForTenant returns only that tenant's webhooks", () => {
    service.register('tenant-1', 'https://a.com', ['message.sent']);
    service.register('tenant-2', 'https://b.com', ['bot.started']);
    service.register('tenant-1', 'https://c.com', ['bot.stopped']);

    expect(service.listForTenant('tenant-1')).toHaveLength(2);
    expect(service.listForTenant('tenant-2')).toHaveLength(1);
  });

  test('update modifies webhook fields', () => {
    const reg = service.register('tenant-1', 'https://a.com', ['message.sent']);

    const updated = service.update(reg.id, 'tenant-1', {
      url: 'https://new.com',
      events: ['message.sent', 'bot.started'],
    });

    expect(updated).toBeDefined();
    expect(updated?.url).toBe('https://new.com');
    expect(updated?.events).toHaveLength(2);
  });

  test('update rejects wrong tenantId', () => {
    const reg = service.register('tenant-1', 'https://a.com', ['message.sent']);
    expect(service.update(reg.id, 'tenant-2', { url: 'https://evil.com' })).toBeUndefined();
  });

  test('delete requires matching tenantId', () => {
    const reg = service.register('tenant-1', 'https://a.com', ['message.sent']);
    expect(service.delete(reg.id, 'tenant-2')).toBe(false);
    expect(service.delete(reg.id, 'tenant-1')).toBe(true);
    expect(service.listForTenant('tenant-1')).toHaveLength(0);
  });

  test('getById requires matching tenantId', () => {
    const reg = service.register('tenant-1', 'https://a.com', ['message.sent']);
    expect(service.getById(reg.id, 'tenant-1')).toBeDefined();
    expect(service.getById(reg.id, 'tenant-2')).toBeUndefined();
  });

  test('re-enabling resets failCount', () => {
    const reg = service.register('tenant-1', 'https://a.com', ['message.sent']);
    // Simulate failures by directly modifying (in practice, delivery failures do this)
    const fetched = service.getById(reg.id, 'tenant-1');
    if (fetched) fetched.failCount = 5;

    const updated = service.update(reg.id, 'tenant-1', { enabled: true });
    expect(updated?.failCount).toBe(0);
  });

  test('persistence across reloads', () => {
    service.register('tenant-1', 'https://a.com', ['message.sent']);

    const service2 = new WebhookService(TEST_DIR, makeLogger());
    expect(service2.listForTenant('tenant-1')).toHaveLength(1);
  });
});

/**
 * `isTenantBot` is the one rule for "this bot belongs to a customer tenant".
 * Live, 2026-10-24: two bots carry `tenantId: '__admin__'` (the admin tenant)
 * and every watcher path that read "any tenantId" as "tenant bot" shut them
 * out of the operator's fleet memory and broadcasts.
 */
import { describe, expect, test } from 'bun:test';
import { isTenantBot } from '../../src/tenant/tenant-scoping';

const on = { multiTenant: { enabled: true } };
const off = { multiTenant: { enabled: false } };

describe('isTenantBot', () => {
  test('a bot of a customer tenant with multi-tenant on is a tenant bot', () => {
    expect(isTenantBot({ tenantId: 't1' }, on)).toBe(true);
  });

  test('a bot of the admin tenant is not a tenant bot', () => {
    expect(isTenantBot({ tenantId: '__admin__' }, on)).toBe(false);
  });

  test('a bot without tenantId is not a tenant bot', () => {
    expect(isTenantBot({}, on)).toBe(false);
    expect(isTenantBot(undefined, on)).toBe(false);
  });

  test('multi-tenant off: never a tenant bot', () => {
    expect(isTenantBot({ tenantId: 't1' }, off)).toBe(false);
    expect(isTenantBot({ tenantId: 't1' }, {})).toBe(false);
  });
});

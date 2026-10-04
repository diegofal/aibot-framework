import { describe, expect, it } from 'bun:test';
import {
  BAAS_TENANT_KEY,
  SESSION_TENANT_KEY,
  rememberTenant,
  restoreTenant,
} from '../../web/pages/baas-helpers.js';

function mem() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
  };
}

describe('baas tenant persistence', () => {
  it('rememberTenant writes both stores; empty value changes nothing', () => {
    const local = mem();
    const session = mem();
    rememberTenant('t1', { local, session });
    expect(local.getItem(BAAS_TENANT_KEY)).toBe('t1');
    expect(session.getItem(SESSION_TENANT_KEY)).toBe('t1');
    rememberTenant('', { local, session });
    expect(local.getItem(BAAS_TENANT_KEY)).toBe('t1');
  });
  it('restoreTenant seeds the session key from localStorage when missing', () => {
    const local = mem();
    const session = mem();
    local.setItem(BAAS_TENANT_KEY, 't2');
    expect(restoreTenant({ local, session })).toBe('t2');
    expect(session.getItem(SESSION_TENANT_KEY)).toBe('t2');
  });
  it('restoreTenant keeps an existing session choice', () => {
    const local = mem();
    const session = mem();
    local.setItem(BAAS_TENANT_KEY, 't2');
    session.setItem(SESSION_TENANT_KEY, 't3');
    expect(restoreTenant({ local, session })).toBe('t3');
  });
  it('never throws when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(restoreTenant({ local: broken, session: broken })).toBe('');
    expect(() => rememberTenant('x', { local: broken, session: broken })).not.toThrow();
  });
});

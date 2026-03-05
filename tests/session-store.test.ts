import { describe, expect, test } from 'bun:test';
import { SessionStore } from '../src/tenant/session-store';

describe('SessionStore', () => {
  test('createSession returns session with sess_ prefix', () => {
    const store = new SessionStore();
    const session = store.createSession({ role: 'admin', name: 'Admin' });
    expect(session.id).toStartWith('sess_');
    expect(session.id.length).toBeGreaterThan(40);
    expect(session.role).toBe('admin');
    expect(session.name).toBe('Admin');
  });

  test('getSession returns valid session', () => {
    const store = new SessionStore();
    const session = store.createSession({ role: 'tenant', tenantId: 't1', name: 'Test' });
    const retrieved = store.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.tenantId).toBe('t1');
    expect(retrieved?.role).toBe('tenant');
  });

  test('getSession returns undefined for unknown id', () => {
    const store = new SessionStore();
    expect(store.getSession('sess_unknown')).toBeUndefined();
  });

  test('getSession returns undefined for expired session', () => {
    const store = new SessionStore(1); // 1ms TTL
    const session = store.createSession({ role: 'admin', name: 'Admin' });
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    expect(store.getSession(session.id)).toBeUndefined();
  });

  test('deleteSession removes session', () => {
    const store = new SessionStore();
    const session = store.createSession({ role: 'admin', name: 'Admin' });
    store.deleteSession(session.id);
    expect(store.getSession(session.id)).toBeUndefined();
  });

  test('cleanup removes expired sessions', () => {
    const store = new SessionStore(1);
    store.createSession({ role: 'admin', name: 'A' });
    store.createSession({ role: 'admin', name: 'B' });
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    store.cleanup();
    expect(store.size).toBe(0);
  });

  test('size returns session count', () => {
    const store = new SessionStore();
    expect(store.size).toBe(0);
    store.createSession({ role: 'admin', name: 'A' });
    expect(store.size).toBe(1);
    store.createSession({ role: 'admin', name: 'B' });
    expect(store.size).toBe(2);
  });
});

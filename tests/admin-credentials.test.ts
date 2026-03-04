import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AdminCredentialStore } from '../src/tenant/admin-credentials';

const TEST_DIR = join(import.meta.dir, '.tmp-admin-creds-test');

describe('AdminCredentialStore', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('exists() returns false when no credentials file', () => {
    const store = new AdminCredentialStore(TEST_DIR);
    expect(store.exists()).toBe(false);
  });

  test('create() stores hashed credentials', async () => {
    const store = new AdminCredentialStore(TEST_DIR);
    await store.create('admin@test.com', 'password123');
    expect(store.exists()).toBe(true);
    expect(existsSync(join(TEST_DIR, 'admin-credentials.json'))).toBe(true);
  });

  test('create() throws if already exists', async () => {
    const store = new AdminCredentialStore(TEST_DIR);
    await store.create('admin@test.com', 'password123');
    expect(store.create('other@test.com', 'pass1234')).rejects.toThrow('already exist');
  });

  test('verify() returns true for correct credentials', async () => {
    const store = new AdminCredentialStore(TEST_DIR);
    await store.create('admin@test.com', 'password123');
    expect(await store.verify('admin@test.com', 'password123')).toBe(true);
  });

  test('verify() is case-insensitive for email', async () => {
    const store = new AdminCredentialStore(TEST_DIR);
    await store.create('Admin@Test.com', 'password123');
    expect(await store.verify('admin@test.com', 'password123')).toBe(true);
  });

  test('verify() returns false for wrong password', async () => {
    const store = new AdminCredentialStore(TEST_DIR);
    await store.create('admin@test.com', 'password123');
    expect(await store.verify('admin@test.com', 'wrongpassword')).toBe(false);
  });

  test('verify() returns false for wrong email', async () => {
    const store = new AdminCredentialStore(TEST_DIR);
    await store.create('admin@test.com', 'password123');
    expect(await store.verify('other@test.com', 'password123')).toBe(false);
  });

  test('verify() returns false when no credentials file exists', async () => {
    const store = new AdminCredentialStore(TEST_DIR);
    expect(await store.verify('admin@test.com', 'password123')).toBe(false);
  });
});

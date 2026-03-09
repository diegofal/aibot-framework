import { describe, expect, test } from 'bun:test';
import {
  generateIdentitySecret,
  generateUserHash,
  verifyUserIdentity,
} from '../../src/tenant/identity-verification';

describe('identity-verification', () => {
  const secret = 'idsec_test_secret_12345';
  const senderId = 'user-abc-123';

  test('generateUserHash returns consistent hex string', () => {
    const hash1 = generateUserHash(secret, senderId);
    const hash2 = generateUserHash(secret, senderId);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 = 64 hex chars
  });

  test('different senderIds produce different hashes', () => {
    const hash1 = generateUserHash(secret, 'user-1');
    const hash2 = generateUserHash(secret, 'user-2');
    expect(hash1).not.toBe(hash2);
  });

  test('different secrets produce different hashes', () => {
    const hash1 = generateUserHash('secret-a', senderId);
    const hash2 = generateUserHash('secret-b', senderId);
    expect(hash1).not.toBe(hash2);
  });

  test('verifyUserIdentity accepts valid hash', () => {
    const hash = generateUserHash(secret, senderId);
    expect(verifyUserIdentity(secret, senderId, hash)).toBe(true);
  });

  test('verifyUserIdentity rejects invalid hash', () => {
    expect(verifyUserIdentity(secret, senderId, 'invalid_hash')).toBe(false);
  });

  test('verifyUserIdentity rejects wrong senderId', () => {
    const hash = generateUserHash(secret, senderId);
    expect(verifyUserIdentity(secret, 'wrong-user', hash)).toBe(false);
  });

  test('verifyUserIdentity rejects wrong secret', () => {
    const hash = generateUserHash(secret, senderId);
    expect(verifyUserIdentity('wrong-secret', senderId, hash)).toBe(false);
  });

  test('verifyUserIdentity handles empty hash', () => {
    expect(verifyUserIdentity(secret, senderId, '')).toBe(false);
  });

  test('generateIdentitySecret produces idsec_ prefixed string', () => {
    const s = generateIdentitySecret();
    expect(s).toMatch(/^idsec_[a-f0-9]{32}$/);
  });

  test('generateIdentitySecret produces unique values', () => {
    const s1 = generateIdentitySecret();
    const s2 = generateIdentitySecret();
    expect(s1).not.toBe(s2);
  });
});

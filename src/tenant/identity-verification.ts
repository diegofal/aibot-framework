/**
 * HMAC-based user identity verification for Widget/REST channels.
 * Prevents senderId spoofing when the widget is embedded in tenant apps.
 * Pattern: tenant generates hash on their backend, widget sends it, server verifies.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Generate an HMAC-SHA256 hash for a user ID using the tenant's identity secret.
 * The tenant calls this on their backend and passes the result to the widget.
 */
export function generateUserHash(identitySecret: string, senderId: string): string {
  return createHmac('sha256', identitySecret).update(senderId).digest('hex');
}

/**
 * Verify a user identity hash using constant-time comparison.
 * Returns true if the hash matches.
 */
export function verifyUserIdentity(
  identitySecret: string,
  senderId: string,
  hash: string
): boolean {
  if (!hash) return false;
  const expected = generateUserHash(identitySecret, senderId);
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== hash.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    // If hash is not valid hex, compare as strings with constant-time
    const a = Buffer.from(expected);
    const b = Buffer.from(hash);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/**
 * Generate a new identity secret for a tenant.
 * Separate from the API key — apiKey authenticates the tenant, identitySecret verifies end-users.
 */
export function generateIdentitySecret(): string {
  return `idsec_${randomUUID().replace(/-/g, '')}`;
}

import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison to prevent timing attacks on secret values.
 * Use this instead of === when comparing API keys, tokens, or secrets.
 *
 * Returns false if either value is empty/undefined.
 */
export function safeCompare(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

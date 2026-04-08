import type { Context, Next } from 'hono';
import type { Logger } from '../logger';
import { RateLimiter } from './rate-limiter';

/**
 * Rate limiting configuration for auth endpoints.
 * Separate from tenant rate limits because auth endpoints
 * don't have tenant context (they ARE the auth flow).
 *
 * Two layers of protection:
 * 1. Per-IP: limits total login attempts from a single source
 * 2. Per-email: limits attempts against a single account (even from distributed IPs)
 */
export interface AuthRateLimitOptions {
  /** Max login attempts per IP within the window (default: 10) */
  maxPerIp: number;
  /** Max login attempts per email within the window (default: 5) */
  maxPerEmail: number;
  /** Window size in ms (default: 15 minutes) */
  windowMs: number;
}

const DEFAULT_OPTIONS: AuthRateLimitOptions = {
  maxPerIp: 10,
  maxPerEmail: 5,
  windowMs: 15 * 60_000, // 15 minutes
};

/**
 * Extracts client IP from request, checking common proxy headers.
 * Falls back to 'unknown' if no IP can be determined.
 */
function getClientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    c.req.header('cf-connecting-ip') ||
    'unknown'
  );
}

/**
 * Creates a Hono middleware that rate-limits authentication attempts.
 *
 * Apply this to login/auth-setup routes to prevent brute-force attacks.
 * Uses in-memory sliding window — no external dependencies.
 *
 * Keys:
 *   - `auth:ip:<ip>` — per-source-IP limiting
 *   - `auth:email:<email>` — per-target-account limiting (only when email is in body)
 */
export function createAuthRateLimitMiddleware(
  logger: Logger,
  opts: Partial<AuthRateLimitOptions> = {}
): { middleware: (c: Context, next: Next) => Promise<Response | undefined>; limiter: RateLimiter } {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const limiter = new RateLimiter(options.windowMs);

  const middleware = async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    const ipKey = `auth:ip:${ip}`;

    // Check IP-level limit first (cheaper, no body parsing)
    const ipResult = limiter.check(ipKey, options.maxPerIp, options.windowMs);
    if (!ipResult.allowed) {
      const retryAfterSec = Math.ceil(ipResult.retryAfterMs / 1000);
      c.header('Retry-After', String(retryAfterSec));
      logger.warn({ ip, retryAfterSec }, 'Auth rate limit exceeded (IP)');
      return c.json(
        {
          error: 'Too Many Requests',
          message: `Too many login attempts. Try again in ${retryAfterSec}s.`,
          retryAfterSec,
        },
        429
      );
    }

    // Try to extract email for per-account limiting (best-effort, don't fail if body is weird)
    let emailResult: { allowed: boolean; remaining: number; retryAfterMs: number } | null = null;
    try {
      const clonedReq = c.req.raw.clone();
      const body = await clonedReq.json();
      if (body?.email && typeof body.email === 'string') {
        const email = body.email.toLowerCase().trim();
        const emailKey = `auth:email:${email}`;
        emailResult = limiter.check(emailKey, options.maxPerEmail, options.windowMs);
        if (!emailResult.allowed) {
          const retryAfterSec = Math.ceil(emailResult.retryAfterMs / 1000);
          c.header('Retry-After', String(retryAfterSec));
          logger.warn({ email, retryAfterSec }, 'Auth rate limit exceeded (email)');
          return c.json(
            {
              error: 'Too Many Requests',
              message: `Too many login attempts for this account. Try again in ${retryAfterSec}s.`,
              retryAfterSec,
            },
            429
          );
        }
      }
    } catch {
      // Body parsing failed — IP check is enough, continue
    }

    // Set informational headers (use the tighter of the two limits)
    const remaining = emailResult
      ? Math.min(ipResult.remaining, emailResult.remaining)
      : ipResult.remaining;
    c.header('X-RateLimit-Remaining', String(remaining));

    return next();
  };

  // Expose limiter for testing and cleanup registration
  return { middleware, limiter };
}

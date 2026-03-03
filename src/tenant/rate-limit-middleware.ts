import type { Context, Next } from 'hono';
import type { Logger } from '../logger';
import type { TenantManager } from './manager';
import { PLAN_RATE_LIMITS, type RateLimitConfig, type RateLimiter } from './rate-limiter';

/**
 * Hono middleware that enforces per-tenant rate limits.
 * Uses the tenant's plan to determine the allowed requests/minute.
 * Returns 429 Too Many Requests with Retry-After header when exceeded.
 */
export function createRateLimitMiddleware(
  rateLimiter: RateLimiter,
  tenantManager: TenantManager,
  logger: Logger
) {
  return async (c: Context, next: Next) => {
    const tenantId = c.get('tenantId') as string | undefined;
    if (!tenantId) {
      // No tenant context — skip rate limiting (single-tenant mode)
      return next();
    }

    const tenant = tenantManager.getTenant(tenantId);
    if (!tenant) {
      return next();
    }

    const plan = tenant.plan;
    const maxRequests = PLAN_RATE_LIMITS[plan] ?? PLAN_RATE_LIMITS.free;
    const key = `tenant:${tenantId}`;

    const result = rateLimiter.check(key, maxRequests);

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
      c.header('Retry-After', String(retryAfterSec));
      logger.warn({ tenantId, plan, retryAfterSec }, 'Rate limit exceeded');
      return c.json(
        {
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${retryAfterSec}s.`,
          plan,
          limit: maxRequests,
          retryAfterSec,
        },
        429
      );
    }

    return next();
  };
}

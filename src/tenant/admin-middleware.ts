import type { Context, Next } from 'hono';
import { safeCompare } from '../crypto-utils';
import type { Logger } from '../logger';
import type { SessionStore } from '../tenant/session-store';

/**
 * Admin authentication middleware.
 * Validates requests against the ADMIN_API_KEY environment variable
 * or a session token with admin role.
 * Used to protect admin-only endpoints (tenant management, settings, etc.)
 *
 * SECURITY: Fail-closed — if ADMIN_API_KEY is not configured, all admin
 * endpoints return 503 Service Unavailable. Never allow unauthenticated access.
 */
export function createAdminAuthMiddleware(logger: Logger, sessionStore?: SessionStore) {
  return async (c: Context, next: Next) => {
    const adminKey = process.env.ADMIN_API_KEY;

    // Fail-closed: if ADMIN_API_KEY is not configured, reject all requests.
    // This prevents accidental exposure of admin endpoints in misconfigured deployments.
    if (!adminKey) {
      logger.error(
        'ADMIN_API_KEY not set — admin endpoints are locked down (503). Set ADMIN_API_KEY to enable admin access.'
      );
      return c.json({ error: 'Admin API not configured' }, 503);
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401);
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return c.json({ error: 'Invalid Authorization format. Expected: Bearer <admin_key>' }, 401);
    }

    // Session token with admin role
    if (token.startsWith('sess_') && sessionStore) {
      const session = sessionStore.getSession(token);
      if (session?.role === 'admin') {
        await next();
        return;
      }
      return c.json({ error: 'Forbidden: not an admin session' }, 403);
    }

    // ADMIN_API_KEY check
    if (!safeCompare(token, adminKey)) {
      logger.warn({ tokenPrefix: token.slice(0, 8) }, 'Invalid admin key attempt');
      return c.json({ error: 'Forbidden: invalid admin key' }, 403);
    }

    await next();
  };
}

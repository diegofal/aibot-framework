/**
 * API paths the multi-tenant auth middleware lets through without a key or
 * session (src/web/server.ts). Each one protects itself: login and onboarding
 * flows, the status probe, and the personal-accounts OAuth callback, which the
 * provider's redirect reaches without the dashboard's Bearer token and which
 * only accepts a signed, single-use state issued by an authenticated
 * `POST /api/personal-accounts/login`.
 */
export function isPublicApiPath(path: string): boolean {
  return (
    path === '/api/status' ||
    path.startsWith('/api/auth/') ||
    path.startsWith('/api/admin/') ||
    path === '/api/tenants' ||
    path.startsWith('/api/tenant/') ||
    path.startsWith('/api/onboarding/') ||
    path.startsWith('/api/personal-accounts/callback/')
  );
}

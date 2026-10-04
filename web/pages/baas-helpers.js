/**
 * Selected-tenant persistence for the BaaS pages (UX overhaul phase 5).
 *
 * `resolveTenantId` in shared.js reads the admin's pick from sessionStorage
 * (`admin_selected_tenant`), which dies with the tab. These helpers mirror it
 * into one localStorage key every BaaS page shares, so the choice survives
 * reloads and new tabs. Storage is injectable for tests and never throws.
 */
export const BAAS_TENANT_KEY = 'aibot.baas.selectedTenant';
export const SESSION_TENANT_KEY = 'admin_selected_tenant';

function stores(opts = {}) {
  const g = globalThis;
  return {
    local: opts.local ?? g.localStorage,
    session: opts.session ?? g.sessionStorage,
  };
}

function read(store, key) {
  try {
    return store?.getItem(key) || '';
  } catch {
    return '';
  }
}

function write(store, key, value) {
  try {
    store?.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** Remember a tenant pick in both stores. An empty value is ignored. */
export function rememberTenant(tenantId, opts) {
  if (!tenantId) return;
  const { local, session } = stores(opts);
  write(local, BAAS_TENANT_KEY, String(tenantId));
  write(session, SESSION_TENANT_KEY, String(tenantId));
}

/**
 * Seed the session key from localStorage when the tab has no pick yet.
 * Returns the effective tenant id ('' when none).
 */
export function restoreTenant(opts) {
  const { local, session } = stores(opts);
  const current = read(session, SESSION_TENANT_KEY);
  if (current) return current;
  const saved = read(local, BAAS_TENANT_KEY);
  if (saved) write(session, SESSION_TENANT_KEY, saved);
  return saved;
}

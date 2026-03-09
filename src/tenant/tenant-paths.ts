import { join, resolve } from 'node:path';

/**
 * Resolve data paths for a tenant.
 * When tenantId is undefined (single-tenant mode), returns standard paths.
 *
 * Directory structure when multi-tenant:
 *   data/tenants/{tenantId}/bots/{botId}/soul/
 *   data/tenants/{tenantId}/bots/{botId}/productions/
 *   data/tenants/{tenantId}/bots/{botId}/sessions/
 *   data/tenants/{tenantId}/bots/{botId}/feedback/
 *   data/tenants/{tenantId}/config.json    (tenant-level config)
 */
export interface TenantPaths {
  /** Root directory for this tenant's data */
  tenantRoot: string;
  /** Soul directory for a specific bot */
  soulDir: string;
  /** Productions/work directory for a specific bot */
  workDir: string;
  /** Sessions directory for a specific bot */
  sessionsDir: string;
  /** Memory database path for this tenant */
  memoryDbPath: string;
}

/**
 * Resolve paths for a bot, respecting tenant isolation.
 * When tenantId is undefined, uses standard (non-tenant) paths.
 */
export function resolveTenantPaths(opts: {
  tenantId: string | undefined;
  botId: string;
  dataDir: string; // base data dir, e.g. './data/tenants'
  defaultSoulDir: string; // e.g. './config/soul'
  defaultProductionsDir: string; // e.g. './productions'
  defaultSessionsDir?: string; // e.g. './data/sessions'
  defaultMemoryDbPath?: string; // e.g. './data/memory.db'
}): TenantPaths {
  const { tenantId, botId, dataDir, defaultSoulDir, defaultProductionsDir } = opts;

  if (!tenantId) {
    return {
      tenantRoot: '',
      soulDir: join(defaultSoulDir, botId),
      workDir: join(defaultProductionsDir, botId),
      sessionsDir: opts.defaultSessionsDir ?? './data/sessions',
      memoryDbPath: opts.defaultMemoryDbPath ?? './data/memory.db',
    };
  }

  const tenantRoot = join(dataDir, tenantId);
  return {
    tenantRoot,
    soulDir: join(tenantRoot, 'bots', botId, 'soul'),
    workDir: join(tenantRoot, 'bots', botId, 'productions'),
    sessionsDir: join(tenantRoot, 'bots', botId, 'sessions'),
    memoryDbPath: join(tenantRoot, 'memory.db'),
  };
}

/**
 * Validate that a given path is within the tenant's root directory.
 * Used to sandbox file operations.
 * When tenantRoot is empty (single-tenant), always returns true.
 */
export function isPathWithinTenant(path: string, tenantRoot: string): boolean {
  if (!tenantRoot) return true; // single-tenant mode
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(tenantRoot);
  return resolvedPath.startsWith(`${resolvedRoot}/`) || resolvedPath === resolvedRoot;
}

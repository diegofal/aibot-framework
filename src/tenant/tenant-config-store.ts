import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TenantConfig, TenantConfigSchema, defaultTenantConfig } from './tenant-config';

/**
 * File-based per-tenant configuration store.
 * Storage layout: {dataDir}/{tenantId}/config.json
 */
export class TenantConfigStore {
  constructor(private dataDir: string) {}

  /** Load config for a tenant. Returns defaults if no config exists. */
  get(tenantId: string): TenantConfig {
    const path = this.configPath(tenantId);
    if (!existsSync(path)) return defaultTenantConfig();
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      return TenantConfigSchema.parse(raw);
    } catch {
      return defaultTenantConfig();
    }
  }

  /** Save (overwrite) config for a tenant. */
  set(tenantId: string, config: TenantConfig): void {
    const dir = join(this.dataDir, tenantId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.configPath(tenantId), JSON.stringify(config, null, 2), 'utf-8');
  }

  /** Partially update config for a tenant (deep merge at top level). */
  update(tenantId: string, partial: Partial<TenantConfig>): TenantConfig {
    const current = this.get(tenantId);
    const merged: TenantConfig = {
      ...current,
      ...partial,
      apiKeys: { ...current.apiKeys, ...partial.apiKeys },
      conversation: { ...current.conversation, ...partial.conversation },
      features: { ...current.features, ...partial.features },
      branding: { ...current.branding, ...partial.branding },
    };
    const validated = TenantConfigSchema.parse(merged);
    this.set(tenantId, validated);
    return validated;
  }

  /** Check if a tenant has a custom config. */
  exists(tenantId: string): boolean {
    return existsSync(this.configPath(tenantId));
  }

  /** Get the API keys for a tenant (returns only set keys, no masking here). */
  getApiKeys(tenantId: string): TenantConfig['apiKeys'] {
    return this.get(tenantId).apiKeys;
  }

  /** Update only API keys for a tenant. */
  setApiKeys(tenantId: string, keys: Partial<TenantConfig['apiKeys']>): void {
    const config = this.get(tenantId);
    config.apiKeys = { ...config.apiKeys, ...keys };
    this.set(tenantId, config);
  }

  private configPath(tenantId: string): string {
    return join(this.dataDir, tenantId, 'config.json');
  }
}

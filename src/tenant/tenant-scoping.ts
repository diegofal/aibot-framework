import type { Context } from 'hono';
import type { BotConfig } from '../config';
import type { TenantContext } from './middleware';

/**
 * Extract tenantId from the Hono context (set by tenant auth middleware).
 * Returns undefined when multi-tenant is not active.
 */
export function getTenantId(c: Context): string | undefined {
  const tenant = c.get('tenant') as TenantContext | undefined;
  return tenant?.tenantId;
}

/**
 * Filter bots to only those belonging to the requesting tenant.
 * When tenantId is undefined (non-multi-tenant mode), returns all bots.
 * When tenantId is __admin__, returns all bots (admin sees everything).
 */
export function scopeBots(bots: BotConfig[], tenantId: string | undefined): BotConfig[] {
  if (!tenantId) return bots;
  if (tenantId === '__admin__') return bots;
  return bots.filter((b) => b.tenantId === tenantId);
}

/**
 * Check if a specific bot belongs to the requesting tenant.
 * When tenantId is undefined (non-multi-tenant mode), always returns true.
 * When tenantId is __admin__, always returns true (admin can access any bot).
 */
export function isBotAccessible(bot: BotConfig, tenantId: string | undefined): boolean {
  if (!tenantId) return true;
  if (tenantId === '__admin__') return true;
  return bot.tenantId === tenantId;
}

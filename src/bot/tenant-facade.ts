import type { BotConfig, Config } from '../config';
import type { Logger } from '../logger';
import { TenantManager, type TenantManagerConfig } from '../tenant/manager';
import { NoOpBillingProvider, type BillingProvider } from '../tenant/billing';
import type { Tenant, UsageEventType } from '../tenant/types';

export interface TenantFacadeDeps {
  config: Config;
  logger: Logger;
  runningBots: Set<string>;
  stopBot: (botId: string) => Promise<void>;
  startBot: (botConfig: BotConfig) => Promise<void>;
}

/**
 * TenantFacade encapsulates all tenant/billing/metering methods that were
 * previously inlined in BotManager. BotManager delegates to this facade.
 */
export class TenantFacade {
  private tenantManager?: TenantManager;
  private billingProvider?: BillingProvider;

  constructor(private deps: TenantFacadeDeps) {}

  // --- Initialization ---

  initializeTenantManager(config: TenantManagerConfig, billing?: BillingProvider): void {
    this.tenantManager = new TenantManager(config, this.deps.logger);
    this.billingProvider = billing ?? new NoOpBillingProvider();
    this.deps.logger.info({ dataDir: config.dataDir }, 'Tenant manager initialized');
  }

  getTenantManager(): TenantManager | undefined {
    return this.tenantManager;
  }

  isMultiTenant(): boolean {
    return this.tenantManager !== undefined;
  }

  // --- Tenant CRUD ---

  createTenant(name: string, email: string, plan: Tenant['plan'] = 'free'): Tenant | undefined {
    if (!this.tenantManager) {
      this.deps.logger.warn('Tenant manager not initialized');
      return undefined;
    }
    return this.tenantManager.createTenant(name, email, plan);
  }

  getTenant(tenantId: string): Tenant | undefined {
    return this.tenantManager?.getTenant(tenantId);
  }

  getTenantByApiKey(apiKey: string): Tenant | undefined {
    return this.tenantManager?.getTenantByApiKey(apiKey);
  }

  listTenants(): Tenant[] {
    return this.tenantManager?.listTenants() ?? [];
  }

  updateTenant(tenantId: string, updates: Partial<Omit<Tenant, 'id' | 'createdAt'>>): Tenant | undefined {
    return this.tenantManager?.updateTenant(tenantId, updates);
  }

  async deleteTenant(tenantId: string): Promise<boolean> {
    if (!this.tenantManager) return false;

    // Stop all bots belonging to this tenant
    const tenantBots = this.deps.config.bots.filter(b => b.tenantId === tenantId);
    for (const bot of tenantBots) {
      if (this.deps.runningBots.has(bot.id)) {
        await this.deps.stopBot(bot.id);
      }
    }

    return this.tenantManager.deleteTenant(tenantId);
  }

  regenerateTenantApiKey(tenantId: string): string | undefined {
    return this.tenantManager?.regenerateApiKey(tenantId);
  }

  // --- Usage Metering ---

  recordUsage(tenantId: string, botId: string, type: UsageEventType, quantity: number = 1, metadata?: Record<string, unknown>): void {
    if (!this.tenantManager) return;

    this.tenantManager.recordUsage({
      tenantId,
      botId,
      messageCount: type === 'message_processed' ? quantity : 0,
      apiCallCount: ['api_call', 'llm_request', 'tool_execution'].includes(type) ? quantity : 0,
      storageBytesUsed: type === 'storage_write' ? quantity : 0,
    });
  }

  getTenantUsage(tenantId: string): { messages: number; apiCalls: number; storage: number } {
    return this.tenantManager?.getCurrentMonthUsage(tenantId) ?? { messages: 0, apiCalls: 0, storage: 0 };
  }

  checkQuota(tenantId: string, type: 'messages' | 'apiCalls' | 'storage', amount: number = 1): boolean {
    return this.tenantManager?.checkQuota(tenantId, type, amount) ?? true;
  }

  // --- Bot Lifecycle with Tenant Awareness ---

  async startBotWithTenant(botConfig: BotConfig): Promise<{ success: boolean; error?: string }> {
    if (botConfig.tenantId && this.tenantManager) {
      const tenant = this.tenantManager.getTenant(botConfig.tenantId);
      if (!tenant) {
        return { success: false, error: 'Tenant not found' };
      }

      if (!this.tenantManager.canCreateBot(botConfig.tenantId, { config: this.deps.config, runningBots: this.deps.runningBots } as any)) {
        return { success: false, error: 'Bot limit exceeded for tenant plan' };
      }
    }

    try {
      await this.deps.startBot(botConfig);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  getTenantBots(tenantId: string): BotConfig[] {
    return this.deps.config.bots.filter(b => b.tenantId === tenantId);
  }

  getRunningTenantBots(tenantId: string): string[] {
    return this.deps.config.bots
      .filter(b => b.tenantId === tenantId && this.deps.runningBots.has(b.id))
      .map(b => b.id);
  }

  // --- Billing Integration ---

  getBillingProvider(): BillingProvider | undefined {
    return this.billingProvider;
  }

  async createBillingCustomer(tenantId: string): Promise<string | undefined> {
    if (!this.billingProvider || !this.tenantManager) return undefined;

    const tenant = this.tenantManager.getTenant(tenantId);
    if (!tenant) return undefined;

    try {
      const customerId = await this.billingProvider.createCustomer(tenant);
      this.tenantManager.updateTenant(tenantId, {
        billing: {
          ...tenant.billing,
          stripeCustomerId: customerId,
        },
      });
      return customerId;
    } catch (err) {
      this.deps.logger.error({ err, tenantId }, 'Failed to create billing customer');
      return undefined;
    }
  }
}

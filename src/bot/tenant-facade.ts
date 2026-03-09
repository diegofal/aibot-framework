import type { BotConfig, Config } from '../config';
import type { Logger } from '../logger';
import { type BillingProvider, NoOpBillingProvider } from '../tenant/billing';
import { TenantManager, type TenantManagerConfig } from '../tenant/manager';
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

    // Rotate old usage records on startup (keeps current month only in main file)
    const rotation = this.tenantManager.rotateUsage();
    if (rotation.archived > 0) {
      this.deps.logger.info(rotation, 'Usage records rotated on startup');
    }

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
    const tenant = this.tenantManager.createTenant(name, email, plan);
    if (tenant) {
      this.deps.logger.info({ tenantId: tenant.id, email }, 'Tenant created');
    }
    return tenant;
  }

  getTenant(tenantId: string): Tenant | undefined {
    return this.tenantManager?.getTenant(tenantId);
  }

  getTenantByApiKey(apiKey: string): Tenant | undefined {
    const tenant = this.tenantManager?.getTenantByApiKey(apiKey);
    if (!tenant && this.tenantManager) {
      this.deps.logger.warn('API key lookup failed — key not found');
    }
    return tenant;
  }

  listTenants(): Tenant[] {
    return this.tenantManager?.listTenants() ?? [];
  }

  updateTenant(
    tenantId: string,
    updates: Partial<Omit<Tenant, 'id' | 'createdAt'>>
  ): Tenant | undefined {
    const tenant = this.tenantManager?.updateTenant(tenantId, updates);
    if (tenant) {
      this.deps.logger.info({ tenantId }, 'Tenant updated');
    }
    return tenant;
  }

  async deleteTenant(tenantId: string): Promise<boolean> {
    if (!this.tenantManager) return false;

    // Stop all bots belonging to this tenant
    const tenantBots = this.deps.config.bots.filter((b) => b.tenantId === tenantId);
    for (const bot of tenantBots) {
      if (this.deps.runningBots.has(bot.id)) {
        await this.deps.stopBot(bot.id);
      }
    }

    const botsStopped = tenantBots.filter((b) => this.deps.runningBots.has(b.id)).length;
    const deleted = this.tenantManager.deleteTenant(tenantId);
    if (deleted) {
      this.deps.logger.info({ tenantId, botsStopped }, 'Tenant deleted');
    }
    return deleted;
  }

  regenerateTenantApiKey(tenantId: string): string | undefined {
    const newKey = this.tenantManager?.regenerateApiKey(tenantId);
    if (newKey) {
      this.deps.logger.warn({ tenantId }, 'Tenant API key regenerated');
    }
    return newKey;
  }

  // --- Usage Metering ---

  recordUsage(
    tenantId: string,
    botId: string,
    type: UsageEventType,
    quantity = 1,
    metadata?: Record<string, unknown>
  ): void {
    if (!this.tenantManager) return;
    if (tenantId === '__admin__') return;

    this.deps.logger.debug({ tenantId, botId, type, quantity }, 'Recording usage');
    this.tenantManager.recordUsage({
      tenantId,
      botId,
      messageCount: type === 'message_processed' ? quantity : 0,
      apiCallCount: ['api_call', 'llm_request', 'tool_execution'].includes(type) ? quantity : 0,
      storageBytesUsed: type === 'storage_write' ? quantity : 0,
    });
  }

  getTenantUsage(tenantId: string): { messages: number; apiCalls: number; storage: number } {
    return (
      this.tenantManager?.getCurrentMonthUsage(tenantId) ?? { messages: 0, apiCalls: 0, storage: 0 }
    );
  }

  checkQuota(tenantId: string, type: 'messages' | 'apiCalls' | 'storage', amount = 1): boolean {
    if (tenantId === '__admin__') return true;
    const allowed = this.tenantManager?.checkQuota(tenantId, type, amount) ?? true;
    if (!allowed) {
      this.deps.logger.warn({ tenantId, type, amount }, 'Quota exceeded');
    }
    return allowed;
  }

  // --- Bot Lifecycle with Tenant Awareness ---

  async startBotWithTenant(botConfig: BotConfig): Promise<{ success: boolean; error?: string }> {
    if (botConfig.tenantId && botConfig.tenantId !== '__admin__' && this.tenantManager) {
      const tenant = this.tenantManager.getTenant(botConfig.tenantId);
      if (!tenant) {
        return { success: false, error: 'Tenant not found' };
      }

      if (
        !this.tenantManager.canCreateBot(botConfig.tenantId, {
          getBotIds: () => [...this.deps.runningBots],
          config: this.deps.config,
        })
      ) {
        return { success: false, error: 'Bot limit exceeded for tenant plan' };
      }
    }

    try {
      await this.deps.startBot(botConfig);
      this.deps.logger.info(
        { tenantId: botConfig.tenantId, botId: botConfig.id },
        'Bot started with tenant'
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  getTenantBots(tenantId: string): BotConfig[] {
    return this.deps.config.bots.filter((b) => b.tenantId === tenantId);
  }

  getRunningTenantBots(tenantId: string): string[] {
    return this.deps.config.bots
      .filter((b) => b.tenantId === tenantId && this.deps.runningBots.has(b.id))
      .map((b) => b.id);
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
      this.deps.logger.info({ tenantId, customerId }, 'Billing customer created');
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

  /**
   * Handle Stripe webhook events to update tenant billing status.
   * Called by the webhook endpoint when Stripe sends events.
   */
  async handleWebhook(
    payload: unknown,
    signature: string
  ): Promise<{ success: boolean; tenantId?: string }> {
    if (!this.billingProvider || !this.tenantManager) {
      return { success: false };
    }

    try {
      const result = await this.billingProvider.handleWebhook(payload, signature);

      if (result.type === 'payment_succeeded' && result.tenantId) {
        const tenant = this.tenantManager.getTenant(result.tenantId);
        if (tenant) {
          this.tenantManager.updateTenant(result.tenantId, {
            billing: {
              ...tenant.billing,
              status: 'active',
              stripeSubscriptionId:
                result.stripeSubscriptionId || tenant.billing?.stripeSubscriptionId,
            },
          });
          this.deps.logger.info(
            { tenantId: result.tenantId, invoiceId: result.invoiceId },
            'Payment succeeded, tenant activated'
          );
        }
        return { success: true, tenantId: result.tenantId };
      }

      if (result.type === 'payment_failed' && result.tenantId) {
        const tenant = this.tenantManager.getTenant(result.tenantId);
        if (tenant) {
          this.tenantManager.updateTenant(result.tenantId, {
            billing: {
              ...tenant.billing,
              status: 'past_due',
            },
          });
          this.deps.logger.warn(
            { tenantId: result.tenantId },
            'Payment failed, tenant marked past_due'
          );
        }
        return { success: true, tenantId: result.tenantId };
      }

      if (result.type === 'subscription_canceled' && result.tenantId) {
        const tenant = this.tenantManager.getTenant(result.tenantId);
        if (tenant) {
          this.tenantManager.updateTenant(result.tenantId, {
            billing: {
              ...tenant.billing,
              status: 'canceled',
            },
          });
          this.deps.logger.info({ tenantId: result.tenantId }, 'Subscription canceled');
        }
        return { success: true, tenantId: result.tenantId };
      }

      return { success: true };
    } catch (err) {
      this.deps.logger.error({ err }, 'Webhook handling failed');
      return { success: false };
    }
  }
}

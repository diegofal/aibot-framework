import type { BotManager } from '../bot/bot-manager';
import type { BotConfig } from '../config';
import type { TenantManager } from './manager';
import type { Tenant, UsageEventType } from './types';
import type { Logger } from '../logger';

/**
 * TenantAwareBotManager wraps BotManager with multi-tenant isolation.
 * 
 * This is the integration layer between the tenant system and the bot system.
 * It ensures:
 * - API key validation on all operations
 * - Quota enforcement before resource-intensive operations
 * - Usage metering for billing
 * - Tenant-scoped bot lifecycle management
 */
export class TenantAwareBotManager {
  constructor(
    private botManager: BotManager,
    private tenantManager: TenantManager,
    private logger: Logger,
  ) {}

  // ============================================================================
  // Tenant Operations
  // ============================================================================

  /**
   * Create a new tenant with API key provisioning.
   */
  createTenant(name: string, email: string, plan: Tenant['plan'] = 'free'): Tenant {
    return this.tenantManager.createTenant(name, email, plan);
  }

  /**
   * Get tenant by ID.
   */
  getTenant(tenantId: string): Tenant | undefined {
    return this.tenantManager.getTenant(tenantId);
  }

  /**
   * Authenticate and get tenant by API key.
   */
  authenticateTenant(apiKey: string): Tenant | undefined {
    return this.tenantManager.getTenantByApiKey(apiKey);
  }

  /**
   * List all tenants (admin only).
   */
  listTenants(): Tenant[] {
    return this.tenantManager.listTenants();
  }

  /**
   * Update tenant plan or configuration.
   */
  updateTenant(tenantId: string, updates: Partial<Omit<Tenant, 'id' | 'createdAt'>>): Tenant | undefined {
    return this.tenantManager.updateTenant(tenantId, updates);
  }

  /**
   * Delete tenant and all associated resources.
   */
  async deleteTenant(tenantId: string): Promise<boolean> {
    // Stop all bots for this tenant first
    const tenantBots = this.getTenantBots(tenantId);
    for (const bot of tenantBots) {
      if (this.botManager.isRunning(bot.id)) {
        await this.botManager.stopBot(bot.id);
      }
    }
    
    return this.tenantManager.deleteTenant(tenantId);
  }

  /**
   * Regenerate API key for tenant.
   */
  regenerateApiKey(tenantId: string): string | undefined {
    return this.tenantManager.regenerateApiKey(tenantId);
  }

  // ============================================================================
  // Bot Lifecycle with Tenant Isolation
  // ============================================================================

  /**
   * Start a bot with full tenant validation.
   * Returns detailed error if validation fails.
   */
  async startBot(botConfig: BotConfig): Promise<{ success: boolean; error?: string }> {
    // Validate tenant exists
    if (!botConfig.tenantId) {
      return { success: false, error: 'Bot must have a tenantId' };
    }

    const tenant = this.tenantManager.getTenant(botConfig.tenantId);
    if (!tenant) {
      return { success: false, error: 'Tenant not found' };
    }

    // Check bot count limit for tenant's plan
    if (!this.tenantManager.canCreateBot(botConfig.tenantId, this.botManager)) {
      const planLimits = this.tenantManager.getPlanLimits(tenant.plan);
      return { 
        success: false, 
        error: `Bot limit exceeded. Plan '${tenant.plan}' allows ${planLimits.maxBots} bots.` 
      };
    }

    // Check quota before starting
    const usage = this.tenantManager.getCurrentMonthUsage(botConfig.tenantId);
    if (usage.messages >= tenant.usageQuota.messagesPerMonth) {
      return { success: false, error: 'Message quota exceeded. Please upgrade your plan.' };
    }

    try {
      await this.botManager.startBot(botConfig);
      
      // Record bot creation usage
      this.tenantManager.recordUsage({
        tenantId: botConfig.tenantId,
        botId: botConfig.id,
        messageCount: 0,
        apiCallCount: 1, // Bot creation counts as API call
        storageBytesUsed: 0,
      });

      this.logger.info({ 
        tenantId: botConfig.tenantId, 
        botId: botConfig.id,
        plan: tenant.plan 
      }, 'Tenant bot started successfully');

      return { success: true };
    } catch (err) {
      this.logger.error({ 
        err, 
        tenantId: botConfig.tenantId, 
        botId: botConfig.id 
      }, 'Failed to start tenant bot');
      return { success: false, error: String(err) };
    }
  }

  /**
   * Stop a bot with tenant verification.
   */
  async stopBot(tenantId: string, botId: string): Promise<{ success: boolean; error?: string }> {
    // Verify bot belongs to tenant
    const bot = this.getTenantBot(tenantId, botId);
    if (!bot) {
      return { success: false, error: 'Bot not found or does not belong to tenant' };
    }

    try {
      await this.botManager.stopBot(botId);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Reset a bot with tenant verification.
   */
  async resetBot(tenantId: string, botId: string): Promise<{ success: boolean; error?: string; result?: unknown }> {
    const bot = this.getTenantBot(tenantId, botId);
    if (!bot) {
      return { success: false, error: 'Bot not found or does not belong to tenant' };
    }

    try {
      const result = await this.botManager.resetBot(botId);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // ============================================================================
  // Tenant-Scoped Queries
  // ============================================================================

  /**
   * Get all bots for a tenant.
   */
  getTenantBots(tenantId: string): BotConfig[] {
    return this.botManager.getTenantBots(tenantId);
  }

  /**
   * Get a specific bot if it belongs to tenant.
   */
  getTenantBot(tenantId: string, botId: string): BotConfig | undefined {
    const bots = this.getTenantBots(tenantId);
    return bots.find(b => b.id === botId);
  }

  /**
   * Get running bots for a tenant.
   */
  getRunningTenantBots(tenantId: string): string[] {
    return this.botManager.getRunningTenantBots(tenantId);
  }

  /**
   * Check if a specific bot is running for a tenant.
   */
  isTenantBotRunning(tenantId: string, botId: string): boolean {
    const running = this.getRunningTenantBots(tenantId);
    return running.includes(botId);
  }

  // ============================================================================
  // Usage Metering
  // ============================================================================

  /**
   * Record usage event for a tenant.
   */
  recordUsage(
    tenantId: string, 
    botId: string, 
    type: UsageEventType, 
    quantity: number = 1,
    metadata?: Record<string, unknown>
  ): void {
    // Map UsageEventType to UsageRecord format
    let messageCount = 0;
    let apiCallCount = 0;
    let storageBytesUsed = 0;

    switch (type) {
      case 'message_processed':
        messageCount = quantity;
        break;
      case 'api_call':
      case 'llm_request':
      case 'tool_execution':
      case 'collaboration_initiated':
        apiCallCount = quantity;
        break;
      case 'storage_write':
        storageBytesUsed = quantity;
        break;
      case 'webhook_received':
        // Webhooks don't count against quota
        break;
    }

    this.tenantManager.recordUsage({
      tenantId,
      botId,
      messageCount,
      apiCallCount,
      storageBytesUsed,
    });
  }

  /**
   * Get current month's usage for a tenant.
   */
  getTenantUsage(tenantId: string): { messages: number; apiCalls: number; storage: number } {
    return this.tenantManager.getCurrentMonthUsage(tenantId);
  }

  /**
   * Check if tenant has quota for operation.
   */
  checkQuota(tenantId: string, type: 'messages' | 'apiCalls' | 'storage', amount: number = 1): boolean {
    return this.tenantManager.checkQuota(tenantId, type, amount);
  }

  /**
   * Get quota status with remaining amounts.
   */
  getQuotaStatus(tenantId: string): { 
    messages: { used: number; limit: number; remaining: number };
    apiCalls: { used: number; limit: number; remaining: number };
    storage: { used: number; limit: number; remaining: number };
  } | undefined {
    const tenant = this.tenantManager.getTenant(tenantId);
    if (!tenant) return undefined;

    const usage = this.tenantManager.getCurrentMonthUsage(tenantId);

    return {
      messages: {
        used: usage.messages,
        limit: tenant.usageQuota.messagesPerMonth,
        remaining: Math.max(0, tenant.usageQuota.messagesPerMonth - usage.messages),
      },
      apiCalls: {
        used: usage.apiCalls,
        limit: tenant.usageQuota.apiCallsPerMonth,
        remaining: Math.max(0, tenant.usageQuota.apiCallsPerMonth - usage.apiCalls),
      },
      storage: {
        used: usage.storage,
        limit: tenant.usageQuota.storageBytes,
        remaining: Math.max(0, tenant.usageQuota.storageBytes - usage.storage),
      },
    };
  }

  // ============================================================================
  // Delegated Operations
  // ============================================================================

  /**
   * Send message through a tenant's bot.
   */
  async sendMessage(tenantId: string, botId: string, chatId: number, text: string): Promise<{ success: boolean; error?: string }> {
    const bot = this.getTenantBot(tenantId, botId);
    if (!bot) {
      return { success: false, error: 'Bot not found or does not belong to tenant' };
    }

    if (!this.botManager.isRunning(botId)) {
      return { success: false, error: 'Bot is not running' };
    }

    try {
      await this.botManager.sendMessage(chatId, text, botId);
      
      // Record message usage
      this.recordUsage(tenantId, botId, 'message_processed');
      
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Run agent loop for a tenant's bot.
   */
  async runAgentLoop(tenantId: string, botId: string): Promise<{ success: boolean; error?: string; result?: unknown }> {
    const bot = this.getTenantBot(tenantId, botId);
    if (!bot) {
      return { success: false, error: 'Bot not found or does not belong to tenant' };
    }

    // Check quota before running agent loop
    if (!this.checkQuota(tenantId, 'apiCalls', 3)) {
      return { success: false, error: 'API call quota exceeded' };
    }

    try {
      const result = await this.botManager.runAgentLoop(botId);
      
      // Record agent loop usage (higher cost)
      this.recordUsage(tenantId, botId, 'api_call', 3);
      
      return { success: true, result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Get ask-human pending count for tenant's bots.
   */
  getAskHumanPending(tenantId: string): Array<{ id: string; botId: string; question: string; timestamp: string }> {
    const allPending = this.botManager.getAskHumanPending();
    const tenantBotIds = new Set(this.getTenantBots(tenantId).map(b => b.id));
    
    return allPending
      .filter(q => tenantBotIds.has(q.botId))
      .map(q => ({
        id: q.id,
        botId: q.botId,
        question: q.question,
        timestamp: q.timestamp,
      }));
  }

  /**
   * Answer an ask-human question for a tenant's bot.
   */
  answerAskHuman(tenantId: string, questionId: string, answer: string): { success: boolean; error?: string } {
    // Verify question belongs to tenant
    const pending = this.getAskHumanPending(tenantId);
    const question = pending.find(q => q.id === questionId);
    
    if (!question) {
      return { success: false, error: 'Question not found or does not belong to tenant' };
    }

    const ok = this.botManager.answerAskHuman(questionId, answer);
    return { success: ok };
  }

  // ============================================================================
  // Plan Management
  // ============================================================================

  /**
   * Upgrade tenant plan.
   */
  async upgradePlan(tenantId: string, newPlan: Tenant['plan']): Promise<{ success: boolean; error?: string }> {
    const tenant = this.tenantManager.getTenant(tenantId);
    if (!tenant) {
      return { success: false, error: 'Tenant not found' };
    }

    // Check if downgrade would exceed new plan limits
    if (this.isDowngrade(tenant.plan, newPlan)) {
      const currentBotCount = this.getTenantBots(tenantId).length;
      const newLimits = this.tenantManager.getPlanLimits(newPlan);
      
      if (currentBotCount > newLimits.maxBots) {
        return { 
          success: false, 
          error: `Cannot downgrade: tenant has ${currentBotCount} bots but new plan allows only ${newLimits.maxBots}. Please delete bots first.` 
        };
      }
    }

    this.tenantManager.updateTenant(tenantId, { plan: newPlan });
    
    this.logger.info({ tenantId, oldPlan: tenant.plan, newPlan }, 'Tenant plan upgraded');
    return { success: true };
  }

  private isDowngrade(currentPlan: string, newPlan: string): boolean {
    const planOrder = ['free', 'starter', 'pro', 'enterprise'];
    return planOrder.indexOf(newPlan) < planOrder.indexOf(currentPlan);
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  /**
   * Get comprehensive tenant statistics.
   */
  getTenantStats(tenantId: string): {
    tenant: Tenant | undefined;
    quotaStatus: ReturnType<TenantAwareBotManager['getQuotaStatus']>;
    bots: {
      total: number;
      running: number;
      maxAllowed: number;
    };
  } {
    const tenant = this.tenantManager.getTenant(tenantId);
    const quotaStatus = this.getQuotaStatus(tenantId);
    const bots = this.getTenantBots(tenantId);
    const running = this.getRunningTenantBots(tenantId);
    const planLimits = tenant ? this.tenantManager.getPlanLimits(tenant.plan) : { maxBots: 0 };

    return {
      tenant,
      quotaStatus,
      bots: {
        total: bots.length,
        running: running.length,
        maxAllowed: planLimits.maxBots,
      },
    };
  }
}

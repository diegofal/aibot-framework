import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';

export interface Tenant {
  id: string;
  name: string;
  email: string;
  plan: 'free' | 'starter' | 'pro' | 'enterprise';
  apiKey: string;
  createdAt: string;
  updatedAt: string;
  usageQuota: {
    messagesPerMonth: number;
    apiCallsPerMonth: number;
    storageBytes: number;
  };
  billing?: {
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
  };
}

export interface UsageRecord {
  tenantId: string;
  botId: string;
  timestamp: string;
  messageCount: number;
  apiCallCount: number;
  storageBytesUsed: number;
}

export interface TenantManagerConfig {
  dataDir: string;
  apiKeyPrefix?: string;
}

const PLAN_LIMITS = {
  free: {
    messagesPerMonth: 500,
    apiCallsPerMonth: 1000,
    storageBytes: 100 * 1024 * 1024, // 100MB
    maxBots: 1,
  },
  starter: {
    messagesPerMonth: 5000,
    apiCallsPerMonth: 10000,
    storageBytes: 1024 * 1024 * 1024, // 1GB
    maxBots: 3,
  },
  pro: {
    messagesPerMonth: 25000,
    apiCallsPerMonth: 50000,
    storageBytes: 5 * 1024 * 1024 * 1024, // 5GB
    maxBots: 10,
  },
  enterprise: {
    messagesPerMonth: 100000,
    apiCallsPerMonth: 200000,
    storageBytes: 20 * 1024 * 1024 * 1024, // 20GB
    maxBots: 50,
  },
};

export class TenantManager {
  private tenantsPath: string;
  private usagePath: string;
  private tenants: Map<string, Tenant> = new Map();
  private apiKeyIndex: Map<string, string> = new Map(); // apiKey -> tenantId

  constructor(
    private config: TenantManagerConfig,
    private logger: Logger
  ) {
    this.tenantsPath = join(config.dataDir, 'tenants.json');
    this.usagePath = join(config.dataDir, 'usage.jsonl');
    this.loadTenants();
  }

  private loadTenants(): void {
    if (existsSync(this.tenantsPath)) {
      try {
        const data = JSON.parse(readFileSync(this.tenantsPath, 'utf-8'));
        for (const tenant of data.tenants || []) {
          this.tenants.set(tenant.id, tenant);
          this.apiKeyIndex.set(tenant.apiKey, tenant.id);
        }
        this.logger.info({ count: this.tenants.size }, 'Loaded tenants');
      } catch (err) {
        this.logger.error({ err }, 'Failed to load tenants');
      }
    }
  }

  private saveTenants(): void {
    const data = {
      tenants: Array.from(this.tenants.values()),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(this.config.dataDir, { recursive: true });
    writeFileSync(this.tenantsPath, JSON.stringify(data, null, 2));
  }

  private generateApiKey(): string {
    const prefix = this.config.apiKeyPrefix || 'aibot_';
    return `${prefix}${randomUUID().replace(/-/g, '')}`;
  }

  createTenant(name: string, email: string, plan: Tenant['plan'] = 'free'): Tenant {
    const id = randomUUID();
    const limits = PLAN_LIMITS[plan];

    const tenant: Tenant = {
      id,
      name,
      email,
      plan,
      apiKey: this.generateApiKey(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usageQuota: {
        messagesPerMonth: limits.messagesPerMonth,
        apiCallsPerMonth: limits.apiCallsPerMonth,
        storageBytes: limits.storageBytes,
        maxBots: limits.maxBots,
      },
    };

    this.tenants.set(id, tenant);
    this.apiKeyIndex.set(tenant.apiKey, id);
    this.saveTenants();

    this.logger.info({ tenantId: id, plan }, 'Created tenant');
    return tenant;
  }

  getTenant(id: string): Tenant | undefined {
    return this.tenants.get(id);
  }

  getTenantByApiKey(apiKey: string): Tenant | undefined {
    const tenantId = this.apiKeyIndex.get(apiKey);
    return tenantId ? this.tenants.get(tenantId) : undefined;
  }

  updateTenant(id: string, updates: Partial<Omit<Tenant, 'id' | 'createdAt'>>): Tenant | undefined {
    const tenant = this.tenants.get(id);
    if (!tenant) return undefined;

    // Handle plan change - update quotas
    if (updates.plan && updates.plan !== tenant.plan) {
      const limits = PLAN_LIMITS[updates.plan];
      updates.usageQuota = {
        messagesPerMonth: limits.messagesPerMonth,
        apiCallsPerMonth: limits.apiCallsPerMonth,
        storageBytes: limits.storageBytes,
        maxBots: limits.maxBots,
      };
    }

    // Re-index if apiKey changed (do this BEFORE Object.assign)
    if (updates.apiKey) {
      this.apiKeyIndex.delete(tenant.apiKey);
      this.apiKeyIndex.set(updates.apiKey, id);
    }

    Object.assign(tenant, updates, { updatedAt: new Date().toISOString() });

    this.saveTenants();
    this.logger.info({ tenantId: id }, 'Updated tenant');
    return tenant;
  }

  deleteTenant(id: string): boolean {
    const tenant = this.tenants.get(id);
    if (!tenant) return false;

    this.apiKeyIndex.delete(tenant.apiKey);
    this.tenants.delete(id);
    this.saveTenants();

    this.logger.info({ tenantId: id }, 'Deleted tenant');
    return true;
  }

  listTenants(): Tenant[] {
    return Array.from(this.tenants.values());
  }

  regenerateApiKey(id: string): string | undefined {
    const tenant = this.tenants.get(id);
    if (!tenant) return undefined;

    this.apiKeyIndex.delete(tenant.apiKey);
    tenant.apiKey = this.generateApiKey();
    tenant.updatedAt = new Date().toISOString();
    this.apiKeyIndex.set(tenant.apiKey, id);
    this.saveTenants();

    this.logger.info({ tenantId: id }, 'Regenerated API key');
    return tenant.apiKey;
  }

  getPlanLimits(plan: Tenant['plan']) {
    return PLAN_LIMITS[plan];
  }

  // Usage tracking
  recordUsage(record: Omit<UsageRecord, 'timestamp'>): void {
    const entry: UsageRecord = {
      ...record,
      timestamp: new Date().toISOString(),
    };

    const line = `${JSON.stringify(entry)}\n`;
    writeFileSync(this.usagePath, line, { flag: 'a' });
  }

  getUsageForPeriod(tenantId: string, startDate: string, endDate: string): UsageRecord[] {
    if (!existsSync(this.usagePath)) return [];

    const records: UsageRecord[] = [];
    const content = readFileSync(this.usagePath, 'utf-8');

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record: UsageRecord = JSON.parse(line);
        if (
          record.tenantId === tenantId &&
          record.timestamp >= startDate &&
          record.timestamp <= endDate
        ) {
          records.push(record);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return records;
  }

  getCurrentMonthUsage(tenantId: string): { messages: number; apiCalls: number; storage: number } {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

    const records = this.getUsageForPeriod(tenantId, startOfMonth, endOfMonth);

    return records.reduce(
      (acc, r) => ({
        messages: acc.messages + r.messageCount,
        apiCalls: acc.apiCalls + r.apiCallCount,
        storage: acc.storage + r.storageBytesUsed,
      }),
      { messages: 0, apiCalls: 0, storage: 0 }
    );
  }

  checkQuota(tenantId: string, type: 'messages' | 'apiCalls' | 'storage', amount: number): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return false;

    const usage = this.getCurrentMonthUsage(tenantId);

    switch (type) {
      case 'messages':
        return usage.messages + amount <= tenant.usageQuota.messagesPerMonth;
      case 'apiCalls':
        return usage.apiCalls + amount <= tenant.usageQuota.apiCallsPerMonth;
      case 'storage':
        return usage.storage + amount <= tenant.usageQuota.storageBytes;
      default:
        return false;
    }
  }

  // Bot counting for plan limits
  getBotCount(
    tenantId: string,
    botManager: { getBotIds(): string[]; config: { bots: Array<{ tenantId?: string }> } }
  ): number {
    return botManager.config.bots.filter((b) => b.tenantId === tenantId).length;
  }

  canCreateBot(
    tenantId: string,
    botManager: { getBotIds(): string[]; config: { bots: Array<{ tenantId?: string }> } }
  ): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return false;

    const limits = PLAN_LIMITS[tenant.plan];
    const currentCount = this.getBotCount(tenantId, botManager);

    return currentCount < limits.maxBots;
  }
}

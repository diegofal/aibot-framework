import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Tenant, TenantStorage, UsageEvent } from './types';

/**
 * File-based storage for tenants.
 * In production, this should be replaced with a database (PostgreSQL, etc.)
 */
export class FileTenantStorage implements TenantStorage {
  private dataDir: string;
  private usageDir: string;

  constructor(baseDir = './data/tenants') {
    this.dataDir = baseDir;
    this.usageDir = join(baseDir, 'usage');

    // Ensure directories exist
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.usageDir, { recursive: true });
  }

  private getTenantPath(id: string): string {
    return join(this.dataDir, `${id}.json`);
  }

  private getUsagePath(tenantId: string, year: number, month: number): string {
    return join(this.usageDir, `${tenantId}_${year}_${month}.jsonl`);
  }

  private serializeTenant(tenant: Tenant): string {
    return JSON.stringify(
      {
        ...tenant,
        createdAt: tenant.createdAt.toISOString(),
        updatedAt: tenant.updatedAt.toISOString(),
        usage: {
          ...tenant.usage,
          lastResetAt: tenant.usage.lastResetAt.toISOString(),
        },
        billing: tenant.billing
          ? {
              ...tenant.billing,
              currentPeriodStart: tenant.billing.currentPeriodStart.toISOString(),
              currentPeriodEnd: tenant.billing.currentPeriodEnd.toISOString(),
            }
          : undefined,
      },
      null,
      2
    );
  }

  private parseTenant(data: string): Tenant {
    const parsed = JSON.parse(data);
    return {
      ...parsed,
      createdAt: new Date(parsed.createdAt),
      updatedAt: new Date(parsed.updatedAt),
      usage: {
        ...parsed.usage,
        lastResetAt: new Date(parsed.usage.lastResetAt),
      },
      billing: parsed.billing
        ? {
            ...parsed.billing,
            currentPeriodStart: new Date(parsed.billing.currentPeriodStart),
            currentPeriodEnd: new Date(parsed.billing.currentPeriodEnd),
          }
        : undefined,
    };
  }

  async save(tenant: Tenant): Promise<void> {
    const path = this.getTenantPath(tenant.id);
    writeFileSync(path, this.serializeTenant(tenant));
  }

  async getById(id: string): Promise<Tenant | undefined> {
    const path = this.getTenantPath(id);
    if (!existsSync(path)) return undefined;

    try {
      const data = readFileSync(path, 'utf-8');
      return this.parseTenant(data);
    } catch {
      return undefined;
    }
  }

  async getByApiKey(apiKey: string): Promise<Tenant | undefined> {
    // In production, this should use a database index
    // For file storage, we iterate (inefficient but simple)
    const all = await this.list();
    return all.find((t) => t.apiKey === apiKey);
  }

  async getByEmail(email: string): Promise<Tenant | undefined> {
    const all = await this.list();
    return all.find((t) => t.email.toLowerCase() === email.toLowerCase());
  }

  async list(): Promise<Tenant[]> {
    if (!existsSync(this.dataDir)) return [];

    const files = readdirSync(this.dataDir).filter((f) => f.endsWith('.json'));
    const tenants: Tenant[] = [];

    for (const file of files) {
      try {
        const data = readFileSync(join(this.dataDir, file), 'utf-8');
        tenants.push(this.parseTenant(data));
      } catch {
        // Skip invalid files
      }
    }

    return tenants;
  }

  async delete(id: string): Promise<void> {
    const path = this.getTenantPath(id);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  async recordUsage(event: UsageEvent): Promise<void> {
    const now = new Date();
    const path = this.getUsagePath(event.tenantId, now.getFullYear(), now.getMonth() + 1);

    const line = `${JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString(),
    })}\n`;

    writeFileSync(path, line, { flag: 'a' });
  }

  async getUsageHistory(tenantId: string, start: Date, end: Date): Promise<UsageEvent[]> {
    const events: UsageEvent[] = [];

    // Collect all relevant files
    const files: string[] = [];
    const current = new Date(start);

    while (current <= end) {
      const path = this.getUsagePath(tenantId, current.getFullYear(), current.getMonth() + 1);
      if (existsSync(path)) {
        files.push(path);
      }
      current.setMonth(current.getMonth() + 1);
    }

    // Read and filter events
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const timestamp = new Date(event.timestamp);
          if (timestamp >= start && timestamp <= end) {
            events.push({
              ...event,
              timestamp,
            });
          }
        } catch {
          // Skip invalid lines
        }
      }
    }

    return events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  async resetMonthlyUsage(tenantId: string): Promise<void> {
    const tenant = await this.getById(tenantId);
    if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);

    tenant.usage.messagesThisMonth = 0;
    tenant.usage.apiCallsThisMonth = 0;
    tenant.usage.storageBytesUsed = 0;
    tenant.usage.collaborationsToday = 0;
    tenant.usage.lastResetAt = new Date();
    tenant.updatedAt = new Date();

    await this.save(tenant);
  }
}

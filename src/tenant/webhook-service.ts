import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';

export type WebhookEventType =
  | 'message.received'
  | 'message.sent'
  | 'bot.started'
  | 'bot.stopped'
  | 'bot.error'
  | 'usage.threshold';

export interface WebhookRegistration {
  id: string;
  tenantId: string;
  url: string;
  events: WebhookEventType[];
  secret: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  failCount: number;
  lastFailAt?: string;
  lastSuccessAt?: string;
}

export interface WebhookPayload {
  id: string;
  event: WebhookEventType;
  tenantId: string;
  botId?: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const MAX_FAIL_COUNT = 10;
const RETRY_DELAYS = [1000, 5000, 30000]; // 1s, 5s, 30s

export class WebhookService {
  private registrations = new Map<string, WebhookRegistration>();
  private filePath: string;

  constructor(
    private dataDir: string,
    private logger: Logger
  ) {
    this.filePath = join(dataDir, 'webhooks.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      for (const reg of data.webhooks ?? []) {
        this.registrations.set(reg.id, reg);
      }
      this.logger.debug({ count: this.registrations.size }, 'Loaded webhook registrations');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load webhook registrations');
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify({ webhooks: Array.from(this.registrations.values()) }, null, 2)
    );
  }

  register(tenantId: string, url: string, events: WebhookEventType[]): WebhookRegistration {
    const id = randomUUID();
    const secret = `whsec_${randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();

    const reg: WebhookRegistration = {
      id,
      tenantId,
      url,
      events,
      secret,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      failCount: 0,
    };

    this.registrations.set(id, reg);
    this.save();
    this.logger.info({ id, tenantId, url, events }, 'Webhook registered');
    return reg;
  }

  update(
    id: string,
    tenantId: string,
    updates: Partial<Pick<WebhookRegistration, 'url' | 'events' | 'enabled'>>
  ): WebhookRegistration | undefined {
    const reg = this.registrations.get(id);
    if (!reg || reg.tenantId !== tenantId) return undefined;

    Object.assign(reg, updates, { updatedAt: new Date().toISOString() });
    // Reset fail count if re-enabled
    if (updates.enabled === true) reg.failCount = 0;
    this.save();
    return reg;
  }

  delete(id: string, tenantId: string): boolean {
    const reg = this.registrations.get(id);
    if (!reg || reg.tenantId !== tenantId) return false;
    this.registrations.delete(id);
    this.save();
    return true;
  }

  listForTenant(tenantId: string): WebhookRegistration[] {
    return Array.from(this.registrations.values()).filter((r) => r.tenantId === tenantId);
  }

  getById(id: string, tenantId: string): WebhookRegistration | undefined {
    const reg = this.registrations.get(id);
    if (!reg || reg.tenantId !== tenantId) return undefined;
    return reg;
  }

  /**
   * Emit an event to all matching webhook registrations for a tenant.
   * Delivery is fire-and-forget with retry.
   */
  async emit(
    tenantId: string,
    event: WebhookEventType,
    data: Record<string, unknown>,
    botId?: string
  ): Promise<void> {
    const matching = Array.from(this.registrations.values()).filter(
      (r) =>
        r.tenantId === tenantId &&
        r.enabled &&
        r.events.includes(event) &&
        r.failCount < MAX_FAIL_COUNT
    );

    if (matching.length === 0) return;

    const payload: WebhookPayload = {
      id: randomUUID(),
      event,
      tenantId,
      botId,
      timestamp: new Date().toISOString(),
      data,
    };

    const deliveries = matching.map((reg) => this.deliver(reg, payload));
    await Promise.allSettled(deliveries);
  }

  private async deliver(reg: WebhookRegistration, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', reg.secret).update(body).digest('hex');

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const response = await fetch(reg.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': `sha256=${signature}`,
            'X-Webhook-Id': payload.id,
            'X-Webhook-Event': payload.event,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok || (response.status >= 200 && response.status < 300)) {
          reg.lastSuccessAt = new Date().toISOString();
          reg.failCount = 0;
          this.save();
          return;
        }

        this.logger.warn(
          { webhookId: reg.id, status: response.status, attempt },
          'Webhook delivery failed'
        );
      } catch (err) {
        this.logger.warn(
          { webhookId: reg.id, err: String(err), attempt },
          'Webhook delivery error'
        );
      }

      // Wait before retry (if not last attempt)
      if (attempt < RETRY_DELAYS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }

    // All retries exhausted
    reg.failCount++;
    reg.lastFailAt = new Date().toISOString();
    if (reg.failCount >= MAX_FAIL_COUNT) {
      reg.enabled = false;
      this.logger.warn(
        { webhookId: reg.id, tenantId: reg.tenantId },
        'Webhook disabled after too many failures'
      );
    }
    this.save();
  }
}

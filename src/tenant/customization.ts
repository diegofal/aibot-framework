import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';

/**
 * Per-tenant customization overlay applied on top of bot template config.
 * These fields are tenant-controlled (set via dashboard/API), not template-controlled.
 */
export interface TenantCustomization {
  tenantId: string;
  botId: string;
  /** Override the bot's display name */
  displayName?: string;
  /** Additional system prompt instructions prepended to the template prompt */
  identityOverride?: string;
  /** Injected knowledge paragraphs (appended to system prompt as context) */
  knowledge?: string[];
  /** Custom goals (replace template goals if provided) */
  goals?: string[];
  /** Custom rules/constraints (appended to system prompt) */
  rules?: string[];
  /** Welcome message override */
  welcomeMessage?: string;
  /** Brand color (hex) for widget */
  brandColor?: string;
  /** Custom avatar URL */
  avatarUrl?: string;
  updatedAt: string;
}

/**
 * Manages tenant customization overlays.
 * Stored per-tenant in the data directory.
 */
export class CustomizationService {
  /** botId -> TenantCustomization */
  private customizations = new Map<string, TenantCustomization>();
  private filePath: string;

  constructor(
    private dataDir: string,
    private logger: Logger
  ) {
    this.filePath = join(dataDir, 'customizations.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      for (const c of data.customizations ?? []) {
        this.customizations.set(c.botId, c);
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load customizations');
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify({ customizations: Array.from(this.customizations.values()) }, null, 2)
    );
  }

  set(customization: Omit<TenantCustomization, 'updatedAt'>): TenantCustomization {
    const full: TenantCustomization = {
      ...customization,
      updatedAt: new Date().toISOString(),
    };
    this.customizations.set(customization.botId, full);
    this.save();
    this.logger.debug(
      { botId: customization.botId, tenantId: customization.tenantId },
      'Customization saved'
    );
    return full;
  }

  get(botId: string): TenantCustomization | undefined {
    return this.customizations.get(botId);
  }

  getForTenant(tenantId: string): TenantCustomization[] {
    return Array.from(this.customizations.values()).filter((c) => c.tenantId === tenantId);
  }

  delete(botId: string, tenantId: string): boolean {
    const c = this.customizations.get(botId);
    if (!c || c.tenantId !== tenantId) return false;
    this.customizations.delete(botId);
    this.save();
    return true;
  }

  /**
   * Compose a system prompt overlay from customization fields.
   * Returns a string to prepend/append to the base system prompt.
   */
  composeOverlay(botId: string): string | undefined {
    const c = this.customizations.get(botId);
    if (!c) return undefined;

    const parts: string[] = [];

    if (c.identityOverride) {
      parts.push(`## Identity\n${c.identityOverride}`);
    }

    if (c.knowledge && c.knowledge.length > 0) {
      parts.push(`## Knowledge\n${c.knowledge.join('\n\n')}`);
    }

    if (c.goals && c.goals.length > 0) {
      parts.push(`## Goals\n${c.goals.map((g, i) => `${i + 1}. ${g}`).join('\n')}`);
    }

    if (c.rules && c.rules.length > 0) {
      parts.push(`## Rules\n${c.rules.map((r) => `- ${r}`).join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }
}

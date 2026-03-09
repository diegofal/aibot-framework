import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig } from '../config';
import type { Logger } from '../logger';

/**
 * A bot template captures the reusable parts of a BotConfig.
 * Tenants spawn bot instances from templates with their own overrides.
 */
export interface BotTemplate {
  id: string;
  name: string;
  description: string;
  /** Base bot config (without token, tenantId, or instance-specific fields) */
  config: TemplateConfig;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string; // admin tenantId
}

/**
 * The subset of BotConfig that a template captures.
 * Excludes: id, token, tenantId, enabled (instance-specific)
 */
export interface TemplateConfig {
  name: string;
  description?: string;
  model?: string;
  llmBackend?: string;
  conversation?: {
    systemPrompt?: string;
    temperature?: number;
    maxHistory?: number;
    maxTokens?: number;
  };
  skills?: string[];
  tools?: { categories?: string[]; disabled?: string[] };
  agentLoop?: Record<string, unknown>;
  tts?: Record<string, unknown>;
  userIsolation?: { enabled: boolean };
  groupActivation?: Record<string, unknown>;
}

export interface TemplateInstance {
  botId: string;
  templateId: string;
  templateVersion: number;
  tenantId: string;
  overrides: Partial<TemplateConfig>;
  createdAt: string;
}

/**
 * Manages bot templates: CRUD + instantiation.
 * Templates are stored as JSON in the data directory.
 */
export class TemplateService {
  private templates = new Map<string, BotTemplate>();
  private instances = new Map<string, TemplateInstance>(); // botId -> instance
  private templatesPath: string;
  private instancesPath: string;

  constructor(
    private dataDir: string,
    private logger: Logger
  ) {
    this.templatesPath = join(dataDir, 'templates.json');
    this.instancesPath = join(dataDir, 'template-instances.json');
    this.load();
  }

  private load(): void {
    if (existsSync(this.templatesPath)) {
      try {
        const data = JSON.parse(readFileSync(this.templatesPath, 'utf-8'));
        for (const t of data.templates ?? []) {
          this.templates.set(t.id, t);
        }
      } catch (err) {
        this.logger.warn({ err }, 'Failed to load templates');
      }
    }
    if (existsSync(this.instancesPath)) {
      try {
        const data = JSON.parse(readFileSync(this.instancesPath, 'utf-8'));
        for (const inst of data.instances ?? []) {
          this.instances.set(inst.botId, inst);
        }
      } catch (err) {
        this.logger.warn({ err }, 'Failed to load template instances');
      }
    }
  }

  private saveTemplates(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(
      this.templatesPath,
      JSON.stringify({ templates: Array.from(this.templates.values()) }, null, 2)
    );
  }

  private saveInstances(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(
      this.instancesPath,
      JSON.stringify({ instances: Array.from(this.instances.values()) }, null, 2)
    );
  }

  // --- Template CRUD ---

  create(
    name: string,
    description: string,
    config: TemplateConfig,
    createdBy: string
  ): BotTemplate {
    const id = randomUUID();
    const now = new Date().toISOString();
    const template: BotTemplate = {
      id,
      name,
      description,
      config,
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy,
    };
    this.templates.set(id, template);
    this.saveTemplates();
    this.logger.info({ templateId: id, name }, 'Template created');
    return template;
  }

  get(id: string): BotTemplate | undefined {
    return this.templates.get(id);
  }

  list(): BotTemplate[] {
    return Array.from(this.templates.values());
  }

  update(
    id: string,
    updates: Partial<Pick<BotTemplate, 'name' | 'description' | 'config'>>
  ): BotTemplate | undefined {
    const template = this.templates.get(id);
    if (!template) return undefined;

    if (updates.config) template.version++;
    Object.assign(template, updates, { updatedAt: new Date().toISOString() });
    this.saveTemplates();
    this.logger.info({ templateId: id, version: template.version }, 'Template updated');
    return template;
  }

  delete(id: string): boolean {
    if (!this.templates.has(id)) return false;
    this.templates.delete(id);
    this.saveTemplates();
    return true;
  }

  // --- Instantiation ---

  /**
   * Create a bot config from a template + tenant overrides.
   * Returns a BotConfig ready to be added to the running config.
   */
  instantiate(
    templateId: string,
    tenantId: string,
    botId: string,
    token: string,
    overrides: Partial<TemplateConfig> = {}
  ): BotConfig | undefined {
    const template = this.templates.get(templateId);
    if (!template) return undefined;

    const base = template.config;
    const merged: BotConfig = {
      id: botId,
      name: overrides.name ?? base.name,
      description: overrides.description ?? base.description ?? '',
      token,
      enabled: true,
      tenantId,
      model: overrides.model ?? base.model,
      llmBackend: (overrides.llmBackend ?? base.llmBackend) as BotConfig['llmBackend'],
      conversation: {
        ...base.conversation,
        ...overrides.conversation,
      },
      skills: overrides.skills ?? base.skills ?? [],
      tools: overrides.tools ?? base.tools,
      agentLoop: overrides.agentLoop ?? base.agentLoop,
      tts: overrides.tts ?? base.tts,
      userIsolation: overrides.userIsolation ?? base.userIsolation ?? { enabled: true },
      groupActivation: (overrides.groupActivation ??
        base.groupActivation) as BotConfig['groupActivation'],
    } as BotConfig;

    // Track instance
    const instance: TemplateInstance = {
      botId,
      templateId,
      templateVersion: template.version,
      tenantId,
      overrides,
      createdAt: new Date().toISOString(),
    };
    this.instances.set(botId, instance);
    this.saveInstances();

    this.logger.info(
      { templateId, botId, tenantId, version: template.version },
      'Bot instantiated from template'
    );
    return merged;
  }

  /**
   * Get the template instance info for a bot (if it was created from a template).
   */
  getInstance(botId: string): TemplateInstance | undefined {
    return this.instances.get(botId);
  }

  /**
   * List all instances of a template.
   */
  getInstancesForTemplate(templateId: string): TemplateInstance[] {
    return Array.from(this.instances.values()).filter((i) => i.templateId === templateId);
  }

  /**
   * Check if a template has a newer version than what a bot instance is running.
   */
  hasUpdate(botId: string): boolean {
    const instance = this.instances.get(botId);
    if (!instance) return false;
    const template = this.templates.get(instance.templateId);
    if (!template) return false;
    return template.version > instance.templateVersion;
  }

  /**
   * Extract a TemplateConfig from an existing BotConfig.
   */
  static extractTemplateConfig(botConfig: BotConfig): TemplateConfig {
    return {
      name: botConfig.name,
      description: botConfig.description,
      model: botConfig.model,
      llmBackend: botConfig.llmBackend,
      conversation: botConfig.conversation,
      skills: botConfig.skills,
      tools: botConfig.tools as TemplateConfig['tools'],
      agentLoop: botConfig.agentLoop as Record<string, unknown>,
      tts: botConfig.tts as Record<string, unknown>,
      userIsolation: botConfig.userIsolation,
      groupActivation: botConfig.groupActivation as Record<string, unknown>,
    };
  }
}

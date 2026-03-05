import type { Config } from '../config';
import type { Logger } from '../logger';
import { OllamaClient } from '../ollama';
import { createLLMClient } from './llm-client';
import { SkillLoader } from './skill-loader';
import type {
  DataStore,
  Skill,
  SkillContext,
  SkillManifest,
  TelegramClient,
  ToolExecuteFn,
} from './types';

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private contexts: Map<string, SkillContext> = new Map();
  private loader: SkillLoader;
  private ollamaClient: OllamaClient;
  private toolExecuteFn: ToolExecuteFn | undefined;

  constructor(
    private config: Config,
    private logger: Logger
  ) {
    this.loader = new SkillLoader(config.paths.skills, logger);
    this.ollamaClient = new OllamaClient(config.ollama, logger);
  }

  /**
   * Inject a tool executor so skill command handlers can call other tools.
   * Called after ToolRegistry.initializeTools() populates the tool list.
   */
  setToolExecutor(fn: ToolExecuteFn): void {
    this.toolExecuteFn = fn;
    // Patch existing contexts so already-loaded skills get the capability
    for (const ctx of this.contexts.values()) {
      ctx.tools = { execute: fn };
    }
  }

  /**
   * Load multiple skills
   */
  async loadSkills(skillIds: string[]): Promise<void> {
    for (const skillId of skillIds) {
      try {
        await this.loadSkill(skillId);
      } catch (error) {
        this.logger.warn({ error, skillId }, 'Skill not found or failed to load, skipping');
      }
    }
  }

  /**
   * Load a single skill
   */
  async loadSkill(skillId: string): Promise<void> {
    if (this.skills.has(skillId)) {
      this.logger.warn({ skillId }, 'Skill already loaded');
      return;
    }

    const skill = await this.loader.loadSkill(skillId);

    // Create skill context
    const context = this.createContext(skillId);
    this.contexts.set(skillId, context);

    // Call onLoad hook if it exists
    if (skill.onLoad) {
      try {
        await skill.onLoad(context);
      } catch (error) {
        this.logger.error({ error, skillId }, 'Skill onLoad hook failed');
        throw error;
      }
    }

    this.skills.set(skillId, skill);
    this.logger.info({ skillId }, 'Skill registered');
  }

  /**
   * Unload a skill
   */
  async unloadSkill(skillId: string): Promise<void> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return;
    }

    // Call onUnload hook if it exists
    if (skill.onUnload) {
      try {
        await skill.onUnload();
      } catch (error) {
        this.logger.error({ error, skillId }, 'Skill onUnload hook failed');
      }
    }

    this.skills.delete(skillId);
    this.contexts.delete(skillId);
    this.logger.info({ skillId }, 'Skill unloaded');
  }

  /**
   * Get the shared OllamaClient instance
   */
  getOllamaClient(): OllamaClient {
    return this.ollamaClient;
  }

  /**
   * Get a skill by ID
   */
  get(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Get all loaded skills
   */
  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Check if a skill is loaded
   */
  has(skillId: string): boolean {
    return this.skills.has(skillId);
  }

  /**
   * List all available built-in skill IDs with their manifests (loaded or not).
   */
  async listAvailable(): Promise<Array<{ id: string; manifest: SkillManifest | null }>> {
    const ids = await this.loader.listSkills();
    return ids.map((id) => ({
      id,
      manifest: this.loader.readManifest(id),
    }));
  }

  /**
   * Get the set of enabled skill IDs from config.
   */
  getEnabledIds(): Set<string> {
    return new Set(this.config.skills.enabled);
  }

  /**
   * Get skill context
   */
  getContext(skillId: string): SkillContext | undefined {
    return this.contexts.get(skillId);
  }

  /**
   * Create a skill context
   */
  createContext(skillId: string, telegramClient?: TelegramClient): SkillContext {
    const skillConfig = this.config.skills.config[skillId] ?? {};
    const dataStore = this.createDataStore(skillId);
    const skillLogger = this.logger.child({ skill: skillId });

    const cfg = skillConfig as Record<string, unknown>;
    const llm = createLLMClient(
      {
        llmBackend: cfg.llmBackend as 'ollama' | 'claude-cli' | undefined,
        claudePath: cfg.claudePath as string | undefined,
        claudeTimeout: cfg.claudeTimeout as number | undefined,
      },
      this.ollamaClient,
      skillLogger
    );

    const ctx: SkillContext = {
      skillId,
      config: skillConfig,
      logger: skillLogger,
      ollama: this.ollamaClient,
      llm,
      telegram: telegramClient || this.createDummyTelegramClient(),
      data: dataStore,
    };
    if (this.toolExecuteFn) {
      ctx.tools = { execute: this.toolExecuteFn };
    }
    return ctx;
  }

  /**
   * Create a simple in-memory data store for a skill
   */
  private createDataStore(skillId: string): DataStore {
    const store = new Map<string, unknown>();

    return {
      get<T = unknown>(key: string): T | undefined {
        return store.get(`${skillId}:${key}`) as T | undefined;
      },
      set(key: string, value: unknown): void {
        store.set(`${skillId}:${key}`, value);
      },
      delete(key: string): boolean {
        return store.delete(`${skillId}:${key}`);
      },
      has(key: string): boolean {
        return store.has(`${skillId}:${key}`);
      },
    };
  }

  /**
   * Create a dummy Telegram client for skills without bot context
   */
  private createDummyTelegramClient(): TelegramClient {
    const logger = this.logger;
    return {
      async sendMessage() {
        logger.warn('Telegram client not available in this context');
      },
      async sendDocument() {
        logger.warn('Telegram client not available in this context');
      },
      async answerCallbackQuery() {
        logger.warn('Telegram client not available in this context');
      },
      async editMessageText() {
        logger.warn('Telegram client not available in this context');
      },
    };
  }
}

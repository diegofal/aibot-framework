import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CollaborationSessionManager } from '../collaboration-session';
import type { CollaborationTracker } from '../collaboration-tracker';
import { type Config, persistBots } from '../config';
import type { ConversationsService } from '../conversations/service';
import type { KarmaService } from '../karma/service';
import type { Logger } from '../logger';
import type { MemoryManager } from '../memory/manager';
import type { SessionManager } from '../session';
import type { ActivityStream } from './activity-stream';
import type { AgentFeedbackStore } from './agent-feedback-store';
import type { AskHumanStore } from './ask-human-store';
import type { AskPermissionStore } from './ask-permission-store';
import type { DynamicToolRegistry } from './dynamic-tool-registry';
import type { ToolAuditLog } from './tool-audit-log';
import type { ToolRegistry } from './tool-registry';

const SOUL_FILES = ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md'] as const;

export interface BotResetDeps {
  sessionManager: SessionManager;
  memoryManager?: MemoryManager;
  agentFeedbackStore: AgentFeedbackStore;
  askHumanStore: AskHumanStore;
  askPermissionStore: AskPermissionStore;
  dynamicToolRegistry?: DynamicToolRegistry | null;
  toolRegistry?: ToolRegistry;
  karmaService?: KarmaService;
  conversationsService?: ConversationsService;
  toolAuditLog?: ToolAuditLog;
  collaborationTracker?: CollaborationTracker;
  collaborationSessions?: CollaborationSessionManager;
  activityStream?: ActivityStream;
  agentLoop?: { clearScheduleForBot(botId: string): boolean };
  logger: Logger;
  config?: Config;
  configPath?: string;
  builtinSkillsPath?: string;
  productionsBaseDir?: string;
}

export class BotResetService {
  constructor(private deps: BotResetDeps) {}

  setDynamicToolRegistry(registry: DynamicToolRegistry | null): void {
    this.deps.dynamicToolRegistry = registry;
  }

  setToolRegistry(registry: ToolRegistry): void {
    this.deps.toolRegistry = registry;
  }

  setAgentLoop(agentLoop: { clearScheduleForBot(botId: string): boolean }): void {
    this.deps.agentLoop = agentLoop;
  }

  async reset(
    botId: string,
    soulDir: string
  ): Promise<{
    ok: true;
    cleared: {
      sessions: number;
      soulRestored: boolean;
      goals: boolean;
      memoryDir: boolean;
      versions: boolean;
      coreMemory: boolean;
      index: boolean;
      feedback: boolean;
      dynamicTools: number;
      karma: boolean;
      productionSkills: string[];
      conversations: number;
      toolAuditLog: boolean;
      productions: boolean;
      agentSchedule: boolean;
      collaborationRecords: number;
      collaborationSessions: number;
      activityEvents: number;
    };
  }> {
    const {
      sessionManager,
      memoryManager,
      agentFeedbackStore,
      askHumanStore,
      askPermissionStore,
      dynamicToolRegistry,
      karmaService,
      logger,
    } = this.deps;

    const cleared = {
      sessions: 0,
      soulRestored: false,
      goals: false,
      memoryDir: false,
      versions: false,
      coreMemory: false,
      index: false,
      feedback: false,
      dynamicTools: 0,
      karma: false,
      productionSkills: [] as string[],
      conversations: 0,
      toolAuditLog: false,
      productions: false,
      agentSchedule: false,
      collaborationRecords: 0,
      collaborationSessions: 0,
      activityEvents: 0,
    };

    // 1. Clear sessions
    cleared.sessions = sessionManager.clearBotSessions(botId);

    // 2. Restore soul files from .baseline/ (or delete if no baseline)
    const baselineDir = join(soulDir, '.baseline');
    const hasBaseline = existsSync(baselineDir);

    for (const file of SOUL_FILES) {
      const baselinePath = join(baselineDir, file);
      const currentPath = join(soulDir, file);
      if (hasBaseline && existsSync(baselinePath)) {
        copyFileSync(baselinePath, currentPath);
        cleared.soulRestored = true;
      } else if (existsSync(currentPath)) {
        unlinkSync(currentPath);
      }
    }

    // 3. Delete GOALS.md
    const goalsPath = join(soulDir, 'GOALS.md');
    if (existsSync(goalsPath)) {
      unlinkSync(goalsPath);
      cleared.goals = true;
    }

    // 4. Delete MEMORY.md at soul root
    const rootMemoryPath = join(soulDir, 'MEMORY.md');
    if (existsSync(rootMemoryPath)) {
      unlinkSync(rootMemoryPath);
    }

    // 5. Recursively delete memory/ and recreate empty
    const memoryDir = join(soulDir, 'memory');
    if (existsSync(memoryDir)) {
      rmSync(memoryDir, { recursive: true });
      cleared.memoryDir = true;
    }
    mkdirSync(memoryDir, { recursive: true });

    // 6. Delete .versions/ recursively
    const versionsDir = join(soulDir, '.versions');
    if (existsSync(versionsDir)) {
      rmSync(versionsDir, { recursive: true });
      cleared.versions = true;
    }

    // 7. Delete feedback.jsonl + clear in-memory feedback store
    const feedbackPath = join(soulDir, 'feedback.jsonl');
    if (existsSync(feedbackPath)) {
      unlinkSync(feedbackPath);
      cleared.feedback = true;
    }
    agentFeedbackStore.clearForBot(botId);

    // 8. Clear core memory
    if (memoryManager) {
      memoryManager.clearCoreMemoryForBot(botId);
      cleared.coreMemory = true;
    }

    // 9. Clear index for this bot only (not all bots)
    if (memoryManager) {
      memoryManager.clearIndexForBot(botId);
      cleared.index = true;
    }

    // 10. Clear ask-human store for this bot
    askHumanStore.clearForBot(botId);

    // 11. Clear ask-permission store for this bot
    askPermissionStore.clearForBot(botId);

    // 12. Clear dynamic tools created by this bot
    if (dynamicToolRegistry) {
      cleared.dynamicTools = dynamicToolRegistry.clearForBot(botId);
    }

    // 13. Clear karma events for this bot
    if (karmaService) {
      karmaService.clearEvents(botId);
      cleared.karma = true;
    }

    // 14. Unload production skill tools from runtime
    if (this.deps.toolRegistry) {
      const unloaded = this.deps.toolRegistry.clearExternalSkillsForBot(botId);
      if (unloaded.length > 0) {
        logger.info({ botId, unloaded }, 'Unloaded production skill tools from runtime');
      }
    }

    // 15. Clean production skills and stale config references
    cleared.productionSkills = this.cleanProductionSkills(botId);

    // 16. Clear conversations
    if (this.deps.conversationsService) {
      cleared.conversations = this.deps.conversationsService.deleteAllForBot(botId);
    }

    // 17. Clear tool audit logs
    if (this.deps.toolAuditLog) {
      cleared.toolAuditLog = this.deps.toolAuditLog.clearForBot(botId);
    }

    // 18. Delete entire productions directory (not just skills)
    if (this.deps.productionsBaseDir) {
      const productionsBotDir = join(this.deps.productionsBaseDir, botId);
      if (existsSync(productionsBotDir)) {
        rmSync(productionsBotDir, { recursive: true });
        cleared.productions = true;
      }
    }

    // 19. Clear agent scheduler state
    if (this.deps.agentLoop) {
      cleared.agentSchedule = this.deps.agentLoop.clearScheduleForBot(botId);
    }

    // 20. Clear collaboration tracker records
    if (this.deps.collaborationTracker) {
      cleared.collaborationRecords = this.deps.collaborationTracker.clearForBot(botId);
    }

    // 21. Clear collaboration sessions
    if (this.deps.collaborationSessions) {
      cleared.collaborationSessions = this.deps.collaborationSessions.clearForBot(botId);
    }

    // 22. Clear activity stream events (in-memory)
    if (this.deps.activityStream) {
      cleared.activityEvents = this.deps.activityStream.clearForBot(botId);
    }

    logger.info({ botId, cleared }, 'Bot reset completed');
    return { ok: true, cleared };
  }

  /**
   * Remove production-only skills (created by the bot at runtime) and clean stale
   * references from config.skills.enabled, botConfig.skills, and config.skills.config.
   * Persists the updated config to disk so the next startup doesn't try to load them.
   */
  private cleanProductionSkills(botId: string): string[] {
    const { config, configPath, builtinSkillsPath, productionsBaseDir, logger } = this.deps;

    // Guard: skip if deps not provided (backward compat)
    if (!config || !configPath || !builtinSkillsPath || !productionsBaseDir) {
      return [];
    }

    const prodSkillsDir = join(productionsBaseDir, botId, 'src', 'skills');
    if (!existsSync(prodSkillsDir)) {
      return [];
    }

    // List production skill IDs (subdirectory names)
    const prodSkillIds = readdirSync(prodSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    if (prodSkillIds.length === 0) {
      return [];
    }

    // List built-in skill IDs (dirs containing skill.json)
    const builtinSkillIds = new Set<string>();
    if (existsSync(builtinSkillsPath)) {
      for (const d of readdirSync(builtinSkillsPath, { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(builtinSkillsPath, d.name, 'skill.json'))) {
          builtinSkillIds.add(d.name);
        }
      }
    }

    // Only remove skills that exist in production but NOT in built-in
    const productionOnlySkills = prodSkillIds.filter((id) => !builtinSkillIds.has(id));

    if (productionOnlySkills.length > 0) {
      const removeSet = new Set(productionOnlySkills);

      // Remove from config.skills.enabled (in-memory)
      config.skills.enabled = config.skills.enabled.filter((id) => !removeSet.has(id));

      // Remove from botConfig.skills (in-memory)
      const botConfig = config.bots.find((b) => b.id === botId);
      if (botConfig) {
        botConfig.skills = botConfig.skills.filter((id) => !removeSet.has(id));
      }

      // Remove from config.skills.config (in-memory)
      for (const id of productionOnlySkills) {
        delete config.skills.config[id];
      }

      // Persist skills to config.json (read raw → mutate → write back)
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (raw.skills?.enabled) {
          raw.skills.enabled = raw.skills.enabled.filter((id: string) => !removeSet.has(id));
        }
        if (raw.skills?.config) {
          for (const id of productionOnlySkills) {
            delete raw.skills.config[id];
          }
        }
        delete raw.bots; // bots live in bots.json now
        writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
      } catch (err) {
        logger.warn(
          { err, configPath },
          'Failed to persist config after production skills cleanup'
        );
      }

      // Persist bots to bots.json (in-memory bots already mutated above)
      try {
        persistBots(configPath, config.bots);
      } catch (err) {
        logger.warn({ err, configPath }, 'Failed to persist bots after production skills cleanup');
      }

      logger.info({ botId, productionOnlySkills }, 'Cleaned production-only skills from config');
    }

    // Delete the production skills directory
    rmSync(prodSkillsDir, { recursive: true });
    logger.info({ botId, prodSkillsDir }, 'Deleted production skills directory');

    return productionOnlySkills;
  }
}

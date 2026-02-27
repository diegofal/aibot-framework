import { existsSync, unlinkSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';
import type { SessionManager } from '../session';
import type { MemoryManager } from '../memory/manager';
import type { AgentFeedbackStore } from './agent-feedback-store';
import type { AskHumanStore } from './ask-human-store';
import type { AskPermissionStore } from './ask-permission-store';

const SOUL_FILES = ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md'] as const;

export interface BotResetDeps {
  sessionManager: SessionManager;
  memoryManager?: MemoryManager;
  agentFeedbackStore: AgentFeedbackStore;
  askHumanStore: AskHumanStore;
  askPermissionStore: AskPermissionStore;
  logger: Logger;
}

export class BotResetService {
  constructor(private deps: BotResetDeps) {}

  async reset(botId: string, soulDir: string): Promise<{
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
    };
  }> {
    const { sessionManager, memoryManager, agentFeedbackStore, askHumanStore, askPermissionStore, logger } = this.deps;

    const cleared = {
      sessions: 0,
      soulRestored: false,
      goals: false,
      memoryDir: false,
      versions: false,
      coreMemory: false,
      index: false,
      feedback: false,
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
      memoryManager.clearCoreMemory();
      cleared.coreMemory = true;
    }

    // 9. Clear index
    if (memoryManager) {
      memoryManager.clearIndex();
      cleared.index = true;
    }

    // 10. Clear ask-human store for this bot
    askHumanStore.clearForBot(botId);

    // 11. Clear ask-permission store for this bot
    askPermissionStore.clearForBot(botId);

    logger.info({ botId, cleared }, 'Bot reset completed');
    return { ok: true, cleared };
  }
}

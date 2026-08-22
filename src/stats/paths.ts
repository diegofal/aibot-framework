/**
 * Where every stats source lives on disk, derived from `Config` the same way
 * the runtime derives it (BotManager, AgentLoop, CronService, …). Keeping
 * this in one place means a path change in the runtime is a one-line fix here.
 */
import { join } from 'node:path';
import {
  type BotConfig,
  type Config,
  resolveAgentConfig,
  resolveAgentConfigWithTenant,
} from '../config';
import type { ChannelState } from './types';

export interface StatsDirs {
  dataDir: string;
  llmQueryLog: string;
  llmStats: string;
  toolAudit: string;
  outcomeLedger: string;
  karma: string;
  scheduler: string;
  conversations: string;
  sessions: string;
  cron: string;
  mesh: string;
  collaboration: string;
  logDir: string;
  logFile: string;
}

export function resolveStatsDirs(config: Config): StatsDirs {
  const dataDir = config.paths?.data ?? './data';
  const logDir = config.paths?.logs ?? join(dataDir, 'logs');
  return {
    dataDir,
    llmQueryLog: join(dataDir, 'llm-query-log'),
    llmStats: join(dataDir, 'llm-stats'),
    toolAudit: join(dataDir, 'tool-audit'),
    outcomeLedger: join(dataDir, 'outcome-ledger'),
    karma: config.karma?.baseDir ?? join(dataDir, 'karma'),
    scheduler: join(dataDir, 'agent-scheduler'),
    conversations: config.conversations?.baseDir ?? join(dataDir, 'conversations'),
    sessions: config.session?.dataDir ?? join(dataDir, 'sessions'),
    cron: config.cron?.storePath ?? join(dataDir, 'cron'),
    mesh: join(dataDir, 'shared', 'knowledge-mesh.jsonl'),
    collaboration: join(dataDir, 'collaboration'),
    logDir,
    logFile: config.logging?.file ?? join(logDir, 'aibot.log'),
  };
}

export interface BotPaths {
  soulDir: string;
  workDir: string;
  backend: 'ollama' | 'claude-cli';
  model: string | null;
}

/**
 * Mirror of the resolution BotManager.startBot performs: tenant-aware when
 * multi-tenant is on and the bot has a tenantId, plain otherwise. A bot
 * without an explicit `llmBackend` runs on ollama, so that is reported.
 */
export function resolveBotPaths(config: Config, bot: BotConfig): BotPaths {
  try {
    const resolved =
      bot.tenantId && config.multiTenant?.enabled
        ? resolveAgentConfigWithTenant(config, undefined, bot, bot.tenantId)
        : resolveAgentConfig(config, bot);
    return {
      soulDir: resolved.soulDir,
      workDir: resolved.workDir,
      backend: resolved.llmBackend ?? 'ollama',
      model: resolved.model ?? null,
    };
  } catch {
    const dataDir = config.multiTenant?.dataDir ?? './data/tenants';
    return {
      soulDir: bot.soulDir ?? `${dataDir}/__admin__/bots/${bot.id}/soul`,
      workDir: bot.workDir ?? `${config.productions?.baseDir ?? './productions'}/${bot.id}`,
      backend: bot.llmBackend ?? 'ollama',
      model: bot.model ?? null,
    };
  }
}

/** Real Telegram bot tokens look like `<digits>:<35 url-safe chars>`. */
const TELEGRAM_TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;

export function classifyToken(token: string | undefined | null): ChannelState {
  const t = (token ?? '').trim();
  if (!t) return 'missing';
  return TELEGRAM_TOKEN.test(t) ? 'configured' : 'placeholder';
}

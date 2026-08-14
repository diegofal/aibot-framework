/**
 * A `Config`-shaped object built straight from the raw JSON, without Zod.
 *
 * Both disaster-recovery paths need this. `loadConfig()` expands `${VAR}` and
 * then validates, so it fails on exactly the two machines that matter most: a
 * target where the operator has not set the variables yet (every fresh
 * restore), and a source whose config is broken badly enough that the web
 * server will not start (the reason you reach for the CLI in the first place).
 *
 * Only the fields the export/import paths actually read are populated. It is
 * cast to `Config` at the boundary; treating it as a full config elsewhere
 * would be wrong.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { BotConfig, Config } from '../config';
import { botsPathFromConfigPath } from '../config';

export const PATH_DEFAULTS = {
  soulDir: './config/soul',
  productions: './productions',
  conversations: './data/conversations',
  karma: './data/karma',
  cron: './data/cron',
  sessions: './data/sessions',
  tools: './data/tools',
  proposals: './data/agent-proposals',
  tenants: './data/tenants',
  memoryDb: './data/memory.db',
  contacts: './data/contacts.json',
} as const;

export function pickPath(source: unknown, path: string[]): unknown {
  let cursor: unknown = source;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

export function pickString(source: unknown, path: string[], fallback: string): string {
  const value = pickPath(source, path);
  return typeof value === 'string' && value !== '' ? value : fallback;
}

export function readRawConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function readRawBots(configPath: string): BotConfig[] {
  const botsPath = botsPathFromConfigPath(configPath);
  if (!existsSync(botsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(botsPath, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Build the config slice used for locating files on disk.
 * Relative paths are resolved against `rootDir` so the caller's cwd is
 * irrelevant — a CLI run from another directory still finds the data.
 */
export function buildEffectiveConfig(
  rawConfig: unknown,
  bots: BotConfig[],
  rootDir: string
): Config {
  const absolutize = (value: string): string =>
    isAbsolute(value) ? value : resolve(rootDir, value);
  const at = (path: string[], fallback: string): string =>
    absolutize(pickString(rawConfig, path, fallback));

  // Per-bot overrides are relative to the instance root, not the process cwd —
  // otherwise `--root /elsewhere` reads soul files from the wrong directory.
  const resolvedBots = bots.map((bot) => ({
    ...bot,
    ...(bot.soulDir ? { soulDir: absolutize(bot.soulDir) } : {}),
    ...(bot.workDir ? { workDir: absolutize(bot.workDir) } : {}),
  }));

  return {
    bots: resolvedBots,
    soul: {
      dir: at(['soul', 'dir'], PATH_DEFAULTS.soulDir),
      search: { dbPath: at(['soul', 'search', 'dbPath'], PATH_DEFAULTS.memoryDb) },
    },
    productions: { baseDir: at(['productions', 'baseDir'], PATH_DEFAULTS.productions) },
    conversations: { baseDir: at(['conversations', 'baseDir'], PATH_DEFAULTS.conversations) },
    karma: { baseDir: at(['karma', 'baseDir'], PATH_DEFAULTS.karma) },
    cron: { storePath: at(['cron', 'storePath'], PATH_DEFAULTS.cron) },
    session: { dataDir: at(['session', 'dataDir'], PATH_DEFAULTS.sessions) },
    dynamicTools: { storePath: at(['dynamicTools', 'storePath'], PATH_DEFAULTS.tools) },
    agentProposals: { storePath: at(['agentProposals', 'storePath'], PATH_DEFAULTS.proposals) },
    multiTenant: { dataDir: at(['multiTenant', 'dataDir'], PATH_DEFAULTS.tenants) },
    phoneCall: { contactsFile: at(['phoneCall', 'contactsFile'], PATH_DEFAULTS.contacts) },
    // resolveAgentConfig() reads these while computing per-bot defaults.
    ollama: { models: { primary: '' } },
    conversation: { systemPrompt: '', temperature: 0.7, maxHistory: 20 },
    claudeCli: {},
  } as unknown as Config;
}

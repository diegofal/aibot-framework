/**
 * Agent Data Loader
 *
 * Reads bot configurations from config.json and optionally enriches
 * them with soul directory data (IDENTITY.md, SOUL.md, etc.).
 *
 * This is a static loader — it reads config at startup. For a live
 * version, it could connect to the running AgentRegistry instead.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Minimal bot config shape — just what we need from config.json
export interface BotConfigEntry {
  id: string;
  name: string;
  enabled: boolean;
  skills: string[];
  description?: string;
  model?: string;
  llmBackend?: string;
  soulDir?: string;
  disabledTools?: string[];
  agentLoop?: {
    mode?: string;
    every?: string;
    reportChatId?: number;
  };
}

export interface AgentCard {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  description: string;
  skills: string[];
  model?: string;
  llmBackend?: string;
  agentLoop?: {
    mode?: string;
    schedule?: string;
  };
  identity?: {
    emoji?: string;
    vibe?: string;
  };
  tags: string[];
}

export interface AgentDataLoader {
  listAgents(filter?: { capability?: string; status?: string }): AgentCard[];
  getAgent(agentId: string): AgentCard | undefined;
}

function mapBotEntry(b: Record<string, unknown>): BotConfigEntry {
  return {
    id: b.id as string,
    name: b.name as string,
    enabled: b.enabled !== false,
    skills: (b.skills as string[]) ?? [],
    description: b.description as string | undefined,
    model: b.model as string | undefined,
    llmBackend: b.llmBackend as string | undefined,
    soulDir: b.soulDir as string | undefined,
    disabledTools: b.disabledTools as string[] | undefined,
    agentLoop: b.agentLoop as BotConfigEntry['agentLoop'],
  };
}

/**
 * Load bots array from bots.json (or fall back to inline bots in config.json).
 */
export function loadBotsFromConfig(configPath: string): BotConfigEntry[] {
  // Try bots.json first
  const botsPath = join(dirname(configPath), 'bots.json');
  if (existsSync(botsPath)) {
    const bots = JSON.parse(readFileSync(botsPath, 'utf-8'));
    if (Array.isArray(bots)) return bots.map(mapBotEntry);
  }

  // Fallback: inline bots in config.json
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  if (!raw.bots || !Array.isArray(raw.bots)) {
    throw new Error(`No bots found in ${botsPath} or ${configPath}`);
  }
  return raw.bots.map(mapBotEntry);
}

/**
 * Try to read identity info from a bot's soul directory.
 * Returns { emoji, vibe } if IDENTITY.md exists and is parseable.
 */
function readIdentity(soulDir: string): { emoji?: string; vibe?: string } | undefined {
  const identityPath = join(soulDir, 'IDENTITY.md');
  if (!existsSync(identityPath)) return undefined;

  try {
    const content = readFileSync(identityPath, 'utf-8');
    const emojiMatch = content.match(/emoji:\s*(.+)/i);
    const vibeMatch = content.match(/vibe:\s*(.+)/i);
    return {
      emoji: emojiMatch?.[1]?.trim(),
      vibe: vibeMatch?.[1]?.trim(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Try to read a short description from SOUL.md if the bot has no description in config.
 */
function readSoulDescription(soulDir: string): string | undefined {
  const soulPath = join(soulDir, 'SOUL.md');
  if (!existsSync(soulPath)) return undefined;

  try {
    const content = readFileSync(soulPath, 'utf-8');
    // Take the first non-empty, non-heading line as a summary
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
        return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Infer tags from a bot's skills, name, and description.
 */
function inferTags(bot: BotConfigEntry, description: string): string[] {
  const tags = new Set<string>();

  // From skills
  for (const skill of bot.skills) {
    tags.add(skill);
  }

  // From id/name keywords
  const nameWords = `${bot.id} ${bot.name} ${description}`.toLowerCase();
  const tagPatterns: [RegExp, string][] = [
    [/job|career|employment|hire/, 'job-search'],
    [/crypto|bitcoin|trading/, 'crypto'],
    [/money|revenue|income|monetiz/, 'monetization'],
    [/content|write|blog/, 'content'],
    [/clone|replicate|digital twin/, 'digital-twin'],
    [/connect|network|discover/, 'networking'],
    [/therapy|mental|wellness/, 'wellness'],
    [/improve|self|growth/, 'self-improvement'],
  ];

  for (const [pattern, tag] of tagPatterns) {
    if (pattern.test(nameWords)) {
      tags.add(tag);
    }
  }

  return Array.from(tags);
}

/**
 * Build an AgentCard from config + soul data.
 */
function buildAgentCard(bot: BotConfigEntry, soulBaseDir: string): AgentCard {
  const soulDir = bot.soulDir ?? join(soulBaseDir, bot.id);
  const identity = readIdentity(soulDir);
  const soulDescription = readSoulDescription(soulDir);
  const description = bot.description ?? soulDescription ?? `${bot.name} agent`;
  const tags = inferTags(bot, description);

  return {
    id: bot.id,
    name: bot.name,
    status: bot.enabled ? 'active' : 'disabled',
    description,
    skills: bot.skills,
    model: bot.model,
    llmBackend: bot.llmBackend,
    agentLoop: bot.agentLoop
      ? {
          mode: bot.agentLoop.mode,
          schedule: bot.agentLoop.every,
        }
      : undefined,
    identity: identity ?? undefined,
    tags,
  };
}

/**
 * Create an AgentDataLoader from a config file path.
 */
export function createAgentDataLoader(configPath: string, soulBaseDir?: string): AgentDataLoader {
  const resolvedConfigPath = resolve(configPath);
  const bots = loadBotsFromConfig(resolvedConfigPath);
  const resolvedSoulDir = soulBaseDir ?? resolve(join(resolvedConfigPath, '..', 'soul'));

  const cards: Map<string, AgentCard> = new Map();
  for (const bot of bots) {
    cards.set(bot.id, buildAgentCard(bot, resolvedSoulDir));
  }

  return {
    listAgents(filter?: { capability?: string; status?: string }): AgentCard[] {
      let agents = Array.from(cards.values());

      // Filter by status
      const statusFilter = filter?.status ?? 'active';
      if (statusFilter !== 'all') {
        agents = agents.filter((a) => a.status === statusFilter);
      }

      // Filter by capability keyword
      if (filter?.capability) {
        const keyword = filter.capability.toLowerCase();
        agents = agents.filter(
          (a) =>
            a.tags.some((t) => t.includes(keyword)) ||
            a.skills.some((s) => s.includes(keyword)) ||
            a.description.toLowerCase().includes(keyword) ||
            a.name.toLowerCase().includes(keyword)
        );
      }

      return agents;
    },

    getAgent(agentId: string): AgentCard | undefined {
      return cards.get(agentId);
    },
  };
}

/**
 * Create an AgentDataLoader from raw bot data (for testing).
 */
export function createAgentDataLoaderFromBots(
  bots: BotConfigEntry[],
  soulBaseDir?: string
): AgentDataLoader {
  const resolvedSoulDir = soulBaseDir ?? '/dev/null';
  const cards: Map<string, AgentCard> = new Map();
  for (const bot of bots) {
    cards.set(bot.id, buildAgentCard(bot, resolvedSoulDir));
  }

  return {
    listAgents(filter?: { capability?: string; status?: string }): AgentCard[] {
      let agents = Array.from(cards.values());
      const statusFilter = filter?.status ?? 'active';
      if (statusFilter !== 'all') {
        agents = agents.filter((a) => a.status === statusFilter);
      }
      if (filter?.capability) {
        const keyword = filter.capability.toLowerCase();
        agents = agents.filter(
          (a) =>
            a.tags.some((t) => t.includes(keyword)) ||
            a.skills.some((s) => s.includes(keyword)) ||
            a.description.toLowerCase().includes(keyword) ||
            a.name.toLowerCase().includes(keyword)
        );
      }
      return agents;
    },
    getAgent(agentId: string): AgentCard | undefined {
      return cards.get(agentId);
    },
  };
}

/**
 * Tool permission matrix — controls tool availability and behavior
 * across execution contexts: agent-loop (autonomous) vs conversation (user-facing).
 *
 * The operator configures per-bot which tools are available in each context.
 * All channels share the same conversation permissions — auth gates who can
 * talk to the bot; once in, capabilities are uniform.
 */

export type PermissionLevel = 'free' | 'inform' | 'confirm' | 'blocked';
export type PermissionMode = 'agent-loop' | 'conversation';

export interface ToolPermissionEntry {
  agentLoop: PermissionLevel;
  conversation: PermissionLevel;
}

/**
 * Default permission matrix — hardcoded sensible defaults.
 *
 * Levels:
 * - free: no restriction
 * - inform: bot explains before executing
 * - confirm: bot asks for explicit confirmation
 * - blocked: tool not available (filtered from definitions)
 */
export const DEFAULT_PERMISSIONS: Record<string, ToolPermissionEntry> = {
  // Safe read-only tools — free everywhere
  get_datetime: { agentLoop: 'free', conversation: 'free' },
  memory_search: { agentLoop: 'free', conversation: 'free' },
  memory_get: { agentLoop: 'free', conversation: 'free' },
  recall_memory: { agentLoop: 'free', conversation: 'free' },
  core_memory_append: { agentLoop: 'free', conversation: 'free' },
  core_memory_replace: { agentLoop: 'free', conversation: 'free' },
  core_memory_search: { agentLoop: 'free', conversation: 'free' },
  save_memory: { agentLoop: 'free', conversation: 'free' },
  manage_goals: { agentLoop: 'free', conversation: 'free' },
  web_search: { agentLoop: 'free', conversation: 'free' },
  web_fetch: { agentLoop: 'free', conversation: 'free' },
  reddit_search: { agentLoop: 'free', conversation: 'free' },
  reddit_hot: { agentLoop: 'free', conversation: 'free' },
  reddit_read: { agentLoop: 'free', conversation: 'free' },
  twitter_search: { agentLoop: 'free', conversation: 'free' },
  twitter_read: { agentLoop: 'free', conversation: 'free' },
  delegate_to_bot: { agentLoop: 'free', conversation: 'free' },
  collaborate: { agentLoop: 'free', conversation: 'free' },
  ask_human: { agentLoop: 'free', conversation: 'free' },
  ask_permission: { agentLoop: 'free', conversation: 'free' },
  read_production_log: { agentLoop: 'free', conversation: 'free' },
  moltbook_register: { agentLoop: 'free', conversation: 'free' },

  // Soul/identity — inform in conversation so users know the bot is changing itself
  update_soul: { agentLoop: 'free', conversation: 'inform' },
  update_identity: { agentLoop: 'free', conversation: 'inform' },

  // File operations — free in agent loop, confirm in conversation
  file_read: { agentLoop: 'free', conversation: 'free' },
  file_write: { agentLoop: 'free', conversation: 'confirm' },
  file_edit: { agentLoop: 'confirm', conversation: 'confirm' },

  // System tools — confirm in agent loop, confirm in conversation (inline approval)
  exec: { agentLoop: 'confirm', conversation: 'confirm' },
  process: { agentLoop: 'confirm', conversation: 'confirm' },
  browser: { agentLoop: 'confirm', conversation: 'confirm' },

  // Social posting
  twitter_post: { agentLoop: 'confirm', conversation: 'confirm' },

  // Communication — phone_call stays blocked (too dangerous for inline approval)
  phone_call: { agentLoop: 'confirm', conversation: 'blocked' },
  send_proactive_message: { agentLoop: 'free', conversation: 'inform' },
  send_message: { agentLoop: 'free', conversation: 'inform' },
  cron: { agentLoop: 'free', conversation: 'inform' },

  // Creation tools — confirm in conversation (inline approval)
  create_tool: { agentLoop: 'confirm', conversation: 'confirm' },
  create_agent: { agentLoop: 'confirm', conversation: 'confirm' },
  improve: { agentLoop: 'confirm', conversation: 'confirm' },

  // Production
  archive_file: { agentLoop: 'free', conversation: 'free' },
  signal_completion: { agentLoop: 'free', conversation: 'free' },
};

/**
 * Mapping from framework tool names → Claude CLI native tool equivalents.
 * When a framework tool is blocked, the corresponding Claude CLI native tools
 * must also be disabled via --disallowedTools to prevent bypass.
 */
export const NATIVE_TOOL_MAP: Record<string, string[]> = {
  exec: ['Bash'],
  file_write: ['Write'],
  file_edit: ['Edit'],
  file_read: ['Read'],
  browser: ['WebFetch', 'WebSearch'],
};

/**
 * Given a list of blocked framework tool names, return the Claude CLI native
 * tool names that should be disabled via --disallowedTools.
 */
export function getBlockedNativeTools(
  mode: PermissionMode,
  allToolNames: string[],
  botOverrides?: Record<string, Partial<ToolPermissionEntry>>
): string[] {
  const blocked = getBlockedTools(mode, allToolNames, botOverrides);
  const nativeTools = new Set<string>();
  for (const toolName of blocked) {
    const natives = NATIVE_TOOL_MAP[toolName];
    if (natives) {
      for (const n of natives) nativeTools.add(n);
    }
  }
  return [...nativeTools];
}

const MODE_KEYS: Record<PermissionMode, keyof ToolPermissionEntry> = {
  'agent-loop': 'agentLoop',
  conversation: 'conversation',
};

/**
 * Look up the permission level for a tool in a given mode.
 * Priority: bot overrides > defaults > 'free' fallback (unknown tools are allowed).
 */
export function getPermissionLevel(
  toolName: string,
  mode: PermissionMode,
  botOverrides?: Record<string, Partial<ToolPermissionEntry>>
): PermissionLevel {
  const key = MODE_KEYS[mode];

  // Bot override takes priority
  const override = botOverrides?.[toolName];
  if (override && override[key] !== undefined) {
    return override[key]!;
  }

  // Default matrix
  const defaultEntry = DEFAULT_PERMISSIONS[toolName];
  if (defaultEntry) {
    return defaultEntry[key];
  }

  // Unknown tools default to 'free'
  return 'free';
}

/**
 * Get the list of tool names that are blocked for a given mode.
 */
export function getBlockedTools(
  mode: PermissionMode,
  allToolNames: string[],
  botOverrides?: Record<string, Partial<ToolPermissionEntry>>
): string[] {
  return allToolNames.filter((name) => getPermissionLevel(name, mode, botOverrides) === 'blocked');
}

/**
 * Build the Sensitive Action Protocol block for system prompts in conversation mode.
 * Lists tools that require inform/confirm behavior.
 */
export function buildSensitiveActionProtocol(
  mode: PermissionMode,
  availableToolNames: string[],
  botOverrides?: Record<string, Partial<ToolPermissionEntry>>
): string | null {
  const informTools: string[] = [];
  const confirmTools: string[] = [];

  for (const name of availableToolNames) {
    const level = getPermissionLevel(name, mode, botOverrides);
    if (level === 'inform') informTools.push(name);
    else if (level === 'confirm') confirmTools.push(name);
  }

  if (informTools.length === 0 && confirmTools.length === 0) return null;

  let block = '\n\n## Sensitive Action Protocol\n\n';

  if (informTools.length > 0) {
    block += `Before using these tools, briefly explain what you intend to do and why: ${informTools.join(', ')}.\n`;
  }

  if (confirmTools.length > 0) {
    block += `These tools require operator approval. Call them normally when needed — the system will pause execution and request approval from the operator through the dashboard. You will receive the result after approval. Do NOT ask for permission yourself in text — just call the tool and let the system handle confirmation: ${confirmTools.join(', ')}.\n`;
  }

  block += 'For all other tools, proceed normally without extra confirmation.';

  return block;
}

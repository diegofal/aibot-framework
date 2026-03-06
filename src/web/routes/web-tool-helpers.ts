import type { BotManager } from '../../bot';
import { claudeGenerate } from '../../claude-cli';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import type { ChatMessage } from '../../ollama';

/**
 * Tools that should never be available in dashboard interactions.
 * These are agent-loop / collaboration / telephony tools that make no sense
 * when a human is directly chatting with a bot via the web UI.
 */
export const DASHBOARD_EXCLUDED_TOOLS = new Set([
  'delegate_to_bot',
  'collaborate',
  'ask_human',
  'ask_permission',
  'signal_completion',
  'phone_call',
  'create_agent',
]);

const TOOL_AWARENESS_SUFFIX =
  '\n\nYou have access to tools (web search, file operations, memory, etc.). Use them when needed to provide accurate, up-to-date information.';

export interface WebGenerateOptions {
  prompt: string;
  systemPrompt: string;
  botId: string;
  botManager: BotManager;
  config: Config;
  logger: Logger;
  maxLength?: number;
  enableTools?: boolean;
  /** When provided, used as the full message array (system + history + user). Overrides prompt/systemPrompt. */
  messages?: ChatMessage[];
}

/**
 * Shared helper for web dashboard LLM interactions.
 *
 * When `messages` is provided, uses them as-is for multi-turn conversations
 * (the system prompt should already be the first message).
 *
 * When `enableTools` is true (default), uses the bot's LLMClient with
 * tool definitions and executor — same path as ConversationPipeline / AgentLoop.
 *
 * When `enableTools` is false, falls back to plain `claudeGenerate()` (text-only,
 * no MCP overhead).
 */
export async function webGenerate(opts: WebGenerateOptions): Promise<string> {
  const { prompt, systemPrompt, botId, botManager, config, logger, maxLength } = opts;
  const enableTools = opts.enableTools !== false;

  if (!enableTools) {
    logger.info(
      { botId, path: 'claude-cli-text-only' },
      'webGenerate: tools disabled, using Claude CLI'
    );
    const claudePath = config.improve?.claudePath ?? 'claude';
    const timeout = config.improve?.timeout ?? 300_000;
    return claudeGenerate(prompt, {
      systemPrompt,
      claudePath,
      timeout,
      maxLength,
      logger,
    });
  }

  // Tool-enabled path: use LLMClient abstraction
  let llmClient: ReturnType<BotManager['getLLMClient']>;
  try {
    llmClient = botManager.getLLMClient(botId);
  } catch {
    // Bot not started or no LLMClient registered — fallback to text-only
    logger.warn({ botId }, 'webGenerate: no LLMClient for bot, falling back to Claude CLI');
    const claudePath = config.improve?.claudePath ?? 'claude';
    const timeout = config.improve?.timeout ?? 300_000;
    return claudeGenerate(prompt, {
      systemPrompt,
      claudePath,
      timeout,
      maxLength,
      logger,
    });
  }

  const toolRegistry = botManager.getToolRegistry();
  const allDefs = toolRegistry.getDefinitionsForBot(botId);
  const filteredDefs = allDefs.filter((d) => !DASHBOARD_EXCLUDED_TOOLS.has(d.function.name));

  if (filteredDefs.length === 0) {
    // No tools available after filtering — use text-only path
    logger.info({ botId }, 'webGenerate: no tools after dashboard filter, using Claude CLI');
    const claudePath = config.improve?.claudePath ?? 'claude';
    const timeout = config.improve?.timeout ?? 300_000;
    return claudeGenerate(prompt, {
      systemPrompt,
      claudePath,
      timeout,
      maxLength,
      logger,
    });
  }

  const toolExecutor = toolRegistry.createExecutor(0, botId);
  const model = botManager.getActiveModel(botId);

  // Build message array: use explicit messages if provided, otherwise wrap prompt/systemPrompt
  const chatMessages: ChatMessage[] = opts.messages ?? [
    { role: 'system', content: `${systemPrompt}${TOOL_AWARENESS_SUFFIX}` },
    { role: 'user', content: prompt },
  ];

  logger.info(
    {
      botId,
      backend: llmClient.backend,
      model,
      toolCount: filteredDefs.length,
      messageCount: chatMessages.length,
    },
    'webGenerate: calling LLM with tools'
  );

  const result = await llmClient.chat(chatMessages, {
    model,
    tools: filteredDefs,
    toolExecutor,
  });
  return result.text;
}

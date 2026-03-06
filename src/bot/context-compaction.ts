import type { CompactionConfig } from '../config';
import type { ChatMessage } from '../ollama';
import type { MemoryFlusher } from './memory-flush';
import type { BotContext } from './types';

export const COMPACTION_SUMMARY_PREFIX = '[CONTEXT_SUMMARY]';

/** Per-message overhead in tokens (role label, separators, etc.) */
const MESSAGE_OVERHEAD_TOKENS = 4;

// --- Pure functions (exported for testing) ---

/** Heuristic: chars / 4 ≈ tokens (same as OpenClaw) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sum tokens of a ChatMessage array with per-message overhead */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/** Resolve context window size based on the LLM backend */
export function resolveContextWindow(
  backend: 'ollama' | 'claude-cli',
  config: CompactionConfig
): number {
  return backend === 'claude-cli'
    ? config.contextWindows.claudeCliTokens
    : config.contextWindows.ollamaTokens;
}

/** Check if a message is a compaction summary */
export function isCompactionSummary(msg: ChatMessage): boolean {
  return msg.role === 'system' && msg.content.startsWith(COMPACTION_SUMMARY_PREFIX);
}

/**
 * Truncate individual messages that exceed maxChars.
 * Tries to break at a newline boundary for readability.
 */
export function truncateOversizedMessages(
  messages: ChatMessage[],
  maxChars: number
): { messages: ChatMessage[]; truncatedCount: number } {
  let truncatedCount = 0;
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.content.length > maxChars) {
      // Try to break at last newline within maxChars
      const slice = msg.content.slice(0, maxChars);
      const lastNewline = slice.lastIndexOf('\n');
      const breakAt = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
      result.push({ ...msg, content: `${msg.content.slice(0, breakAt)}\n[...truncated]` });
      truncatedCount++;
    } else {
      result.push(msg);
    }
  }

  return { messages: result, truncatedCount };
}

// --- CompactionResult ---

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  droppedCount?: number;
  summaryTokens?: number;
}

// --- ContextCompactor class ---

export class ContextCompactor {
  constructor(
    private ctx: BotContext,
    private memoryFlusher: MemoryFlusher
  ) {}

  /**
   * Check if messages are approaching the context window and compact if needed.
   * Returns the (possibly compacted) message array.
   */
  async maybeCompact(
    messages: ChatMessage[],
    serializedKey: string,
    botId: string,
    config: CompactionConfig
  ): Promise<CompactionResult> {
    if (!config.enabled) {
      return { messages, compacted: false };
    }

    const backend = this.ctx.getLLMClient(botId).backend;
    const contextWindow = resolveContextWindow(backend, config);
    const totalTokens = estimateMessagesTokens(messages);
    const threshold = contextWindow * config.thresholdRatio;

    if (totalTokens < threshold) {
      return { messages, compacted: false };
    }

    const botLogger = this.ctx.getBotLogger(botId);
    botLogger.info(
      { totalTokens, threshold, contextWindow, messageCount: messages.length },
      'Context compaction triggered'
    );

    // Separate: system prompt (first), existing summary, older messages, recent messages, user message (last)
    const systemMsg =
      messages[0]?.role === 'system' && !isCompactionSummary(messages[0]) ? messages[0] : null;

    const startIdx = systemMsg ? 1 : 0;
    const userMsg =
      messages[messages.length - 1]?.role === 'user' ? messages[messages.length - 1] : null;
    const endIdx = userMsg ? messages.length - 1 : messages.length;

    // Middle messages (between system prompt and user message)
    const middle = messages.slice(startIdx, endIdx);

    // Filter out existing summaries
    const nonSummary = middle.filter((m) => !isCompactionSummary(m));

    // Split into older + recent
    const keepRecent = Math.min(config.keepRecentMessages, nonSummary.length);
    const olderMessages = nonSummary.slice(0, nonSummary.length - keepRecent);
    const recentMessages = nonSummary.slice(nonSummary.length - keepRecent);

    if (olderMessages.length < 2) {
      return { messages, compacted: false };
    }

    // Fire-and-forget memory flush of older messages
    this.memoryFlusher.flushWithScoring(olderMessages, botId).catch((err) => {
      botLogger.warn({ err }, 'Memory flush during compaction failed (non-fatal)');
    });

    // LLM summarization
    let summaryText: string;
    try {
      summaryText = await this.summarizeWithLLM(olderMessages, botId);
    } catch (err) {
      botLogger.warn({ err }, 'LLM summarization failed, using mechanical fallback');
      summaryText = this.mechanicalSummary(olderMessages);
    }

    const summaryMsg: ChatMessage = {
      role: 'system',
      content: `${COMPACTION_SUMMARY_PREFIX} ${summaryText}`,
    };

    // Persist: rewrite transcript with summary + recent messages
    this.ctx.sessionManager.rewriteWithSummary(serializedKey, summaryMsg, recentMessages);

    // Build compacted message array
    const compacted: ChatMessage[] = [];
    if (systemMsg) compacted.push(systemMsg);
    compacted.push(summaryMsg);
    compacted.push(...recentMessages);
    if (userMsg) compacted.push(userMsg);

    const summaryTokens = estimateTokens(summaryText);
    botLogger.info(
      {
        droppedCount: olderMessages.length,
        keptRecent: recentMessages.length,
        summaryTokens,
        newTotal: estimateMessagesTokens(compacted),
      },
      'Context compaction complete'
    );

    this.ctx.activityStream?.publish({
      type: 'compaction',
      botId,
      timestamp: Date.now(),
      data: {
        droppedCount: olderMessages.length,
        keptRecent: recentMessages.length,
        summaryTokens,
      },
    });

    return {
      messages: compacted,
      compacted: true,
      droppedCount: olderMessages.length,
      summaryTokens,
    };
  }

  /** Use the bot's LLM client to summarize older messages */
  private async summarizeWithLLM(olderMessages: ChatMessage[], botId: string): Promise<string> {
    const transcript = olderMessages.map((m) => `${m.role}: ${m.content}`).join('\n');

    const summaryMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Summarize this conversation concisely, preserving key facts, decisions, ' +
          'user preferences, and context needed for continuity. Output only the summary, no preamble.',
      },
      { role: 'user', content: transcript },
    ];

    const llmClient = this.ctx.getLLMClient(botId);
    const model = this.ctx.getActiveModel(botId);
    const result = await llmClient.chat(summaryMessages, { model, temperature: 0.3 });
    return result.text;
  }

  /** Fallback: build a mechanical summary from first lines of each message */
  private mechanicalSummary(olderMessages: ChatMessage[]): string {
    const lines: string[] = [];
    for (const msg of olderMessages) {
      const firstLine = msg.content.split('\n')[0].slice(0, 200);
      lines.push(`${msg.role}: ${firstLine}`);
    }
    return `Previous conversation (${olderMessages.length} messages):\n${lines.join('\n')}`;
  }
}

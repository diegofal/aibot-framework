import type { ChatMessage } from '../ollama';
import { claudeGenerate } from '../claude-cli';
import type { BotContext } from './types';

export class MemoryFlusher {
  constructor(private ctx: BotContext) {}

  /**
   * Summarize a conversation and write to the daily memory log.
   * Used by both session-expiry flush and proactive flush.
   */
  async flushToDaily(history: ChatMessage[], botId?: string): Promise<void> {
    try {
      const transcript = history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'Summarize this conversation into key facts, preferences, and context worth remembering. ' +
            'Bullet points, concise. Only include things that would be useful in future conversations. ' +
            'Output ONLY the bullet points, no preamble.',
        },
        { role: 'user', content: transcript },
      ];

      const soulLoader = botId ? this.ctx.getSoulLoader(botId) : this.ctx.defaultSoulLoader;

      let summary: string;
      const claudePath = this.ctx.config.improve?.claudePath;
      if (claudePath) {
        try {
          const fullPrompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
          summary = await claudeGenerate(fullPrompt, {
            claudePath,
            timeout: 60_000,
            logger: this.ctx.logger,
          });
        } catch (err) {
          this.ctx.logger.warn({ err }, 'Claude CLI failed for memory flush, falling back to Ollama');
          const model = botId ? this.ctx.getActiveModel(botId) : this.ctx.config.ollama.models.primary;
          summary = await this.ctx.ollamaClient.chat(messages, { model, temperature: 0.3 });
        }
      } else {
        const model = botId ? this.ctx.getActiveModel(botId) : this.ctx.config.ollama.models.primary;
        summary = await this.ctx.ollamaClient.chat(messages, { model, temperature: 0.3 });
      }

      if (summary.trim()) {
        soulLoader.appendDailyMemory(summary.trim());
        this.ctx.logger.info('Conversation flushed to daily memory log');
      }
    } catch (err) {
      this.ctx.logger.warn({ err }, 'Failed to flush to daily memory log');
    }
  }

  /**
   * Summarize a conversation and append to memory.
   * Called before any session clear (expiry or /clear) so key facts survive.
   */
  async flushSessionToMemory(history: ChatMessage[], botId?: string): Promise<void> {
    await this.flushToDaily(history, botId);
  }
}

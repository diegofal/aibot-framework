import { claudeGenerate } from '../claude-cli';
import type { ChatMessage } from '../ollama';
import type { BotContext } from './types';

export interface ScoredFact {
  fact: string;
  importance: number; // 1-10
  category: 'identity' | 'relationships' | 'preferences' | 'goals' | 'constraints' | 'general';
}

export class MemoryFlusher {
  constructor(private ctx: BotContext) {}

  /**
   * Summarize a conversation and write to the daily memory log.
   * Used by both session-expiry flush and proactive flush.
   * @deprecated Use flushWithScoring for importance-weighted memory
   */
  async flushToDaily(history: ChatMessage[], botId: string, userId?: string): Promise<void> {
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

      const soulLoader = this.ctx.getSoulLoader(botId);

      let summary: string;
      const claudePath = this.ctx.config.improve?.claudePath;
      const model = this.ctx.getActiveModel(botId);
      const flushStartMs = Date.now();
      if (claudePath) {
        try {
          const fullPrompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
          const claudeResult = await claudeGenerate(fullPrompt, {
            claudePath,
            model: this.ctx.config.claudeCli?.model,
            timeout: 300_000,
            logger: this.ctx.logger,
          });
          summary = claudeResult.response;
        } catch (err) {
          this.ctx.logger.warn(
            { err },
            'Claude CLI failed for memory flush, falling back to Ollama'
          );
          summary = (await this.ctx.ollamaClient.chat(messages, { model, temperature: 0.3 })).text;
        }
      } else {
        summary = (await this.ctx.ollamaClient.chat(messages, { model, temperature: 0.3 })).text;
      }
      this.ctx.llmQueryLog?.append({
        timestamp: new Date().toISOString(),
        botId,
        userId,
        caller: 'memory_flush',
        model,
        backend: claudePath ? 'claude-cli' : 'ollama',
        temperature: 0.3,
        messageCount: messages.length,
        durationMs: Date.now() - flushStartMs,
        success: true,
      });

      if (summary.trim()) {
        soulLoader.appendDailyMemory(summary.trim(), userId);
        this.ctx.logger.info({ userId }, 'Conversation flushed to daily memory log');
      }
    } catch (err) {
      this.ctx.logger.warn({ err }, 'Failed to flush to daily memory log');
    }
  }

  /**
   * Summarize a conversation with importance scoring and store in Core Memory.
   * Each fact gets a score 1-10 (10 = critical, 1 = trivial) and a category.
   * High-importance facts are weighted more heavily in searches.
   */
  async flushWithScoring(
    history: ChatMessage[],
    botId: string,
    userId?: string
  ): Promise<ScoredFact[]> {
    this.ctx.activityStream?.publish({
      type: 'memory:flush',
      botId,
      timestamp: Date.now(),
      phase: 'start',
      data: { messageCount: history.length },
    });
    try {
      const transcript = history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'Analyze this conversation and extract key facts worth remembering. ' +
            'For each fact, assign:\n' +
            '- importance: 1-10 (10 = critical identity/relationship info, 5 = useful context, 1 = trivial)\n' +
            '- category: identity | relationships | preferences | goals | constraints | general\n\n' +
            'Output as JSON array: [{"fact": "...", "importance": N, "category": "..."}, ...]\n' +
            'Only include facts that would actually be useful in future conversations.',
        },
        { role: 'user', content: transcript },
      ];

      let response: string;
      const claudePath = this.ctx.config.improve?.claudePath;
      const model = this.ctx.getActiveModel(botId);
      const scoringStartMs = Date.now();

      if (claudePath) {
        try {
          const fullPrompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
          const claudeResult = await claudeGenerate(fullPrompt, {
            claudePath,
            model: this.ctx.config.claudeCli?.model,
            timeout: 300_000,
            logger: this.ctx.logger,
          });
          response = claudeResult.response;
        } catch (err) {
          this.ctx.logger.warn(
            { err },
            'Claude CLI failed for memory scoring, falling back to Ollama'
          );
          response = (await this.ctx.ollamaClient.chat(messages, { model, temperature: 0.3 })).text;
        }
      } else {
        response = (await this.ctx.ollamaClient.chat(messages, { model, temperature: 0.3 })).text;
      }
      this.ctx.llmQueryLog?.append({
        timestamp: new Date().toISOString(),
        botId,
        userId,
        caller: 'memory_flush',
        model,
        backend: claudePath ? 'claude-cli' : 'ollama',
        temperature: 0.3,
        messageCount: messages.length,
        durationMs: Date.now() - scoringStartMs,
        success: true,
      });

      const facts = this.parseScoredFacts(response);

      // Store in Core Memory
      const coreMemory = this.ctx.memoryManager?.getCoreMemory();
      if (coreMemory && facts.length > 0) {
        for (const fact of facts) {
          const key = this.generateFactKey(fact);
          await coreMemory.set(fact.category, key, fact.fact, fact.importance, botId, userId);
        }
        this.ctx.logger.info(
          { count: facts.length },
          'Conversation flushed to Core Memory with scoring'
        );
        this.ctx.activityStream?.publish({
          type: 'memory:flush',
          botId: botId || '',
          timestamp: Date.now(),
          phase: 'end',
          data: { factCount: facts.length },
        });
      } else if (facts.length > 0) {
        // Fallback to daily log if Core Memory not available
        const soulLoader = this.ctx.getSoulLoader(botId);
        const summary = facts.map((f) => `[${f.importance}/10] ${f.fact}`).join('\n');
        soulLoader.appendDailyMemory(summary, userId);
        this.ctx.logger.info(
          { count: facts.length },
          'Conversation flushed to daily log (Core Memory unavailable)'
        );
      }

      return facts;
    } catch (err) {
      this.ctx.logger.warn({ err }, 'Failed to flush with scoring, falling back to simple flush');
      // Fallback to legacy behavior
      await this.flushToDaily(history, botId, userId);
      return [];
    }
  }

  /**
   * Parse LLM response into scored facts.
   * Handles JSON array or falls back to line parsing.
   */
  private parseScoredFacts(response: string): ScoredFact[] {
    const facts: ScoredFact[] = [];

    // Try to extract JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as unknown[];
        for (const item of parsed) {
          if (this.isValidScoredFact(item)) {
            facts.push({
              fact: item.fact,
              importance: Math.max(1, Math.min(10, Math.round(item.importance))),
              category: item.category,
            });
          }
        }
        if (facts.length > 0) return facts;
      } catch {
        // JSON parsing failed, fall through to line parsing
      }
    }

    // Fallback: parse lines like "- [8] Fact here" or "[7/10] Fact here"
    const lines = response.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      const match = line.match(/\[(\d+)(?:\/(?:10))?\]\s*(.+)/);
      if (match) {
        const importance = Math.max(1, Math.min(10, Number.parseInt(match[1], 10)));
        facts.push({
          fact: match[2].trim(),
          importance,
          category: 'general',
        });
      }
    }

    return facts;
  }

  private isValidScoredFact(
    item: unknown
  ): item is { fact: string; importance: number; category: ScoredFact['category'] } {
    const validCategories: ScoredFact['category'][] = [
      'identity',
      'relationships',
      'preferences',
      'goals',
      'constraints',
      'general',
    ];
    return (
      typeof item === 'object' &&
      item !== null &&
      'fact' in item &&
      typeof (item as Record<string, unknown>).fact === 'string' &&
      'importance' in item &&
      typeof (item as Record<string, unknown>).importance === 'number' &&
      'category' in item &&
      validCategories.includes((item as Record<string, unknown>).category as ScoredFact['category'])
    );
  }

  private generateFactKey(fact: ScoredFact): string {
    // Generate a stable key from the fact content (first 50 chars, normalized)
    const normalized = fact.fact
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .slice(0, 50)
      .replace(/\s+/g, '_');
    return normalized || `fact_${Date.now()}`;
  }

  /**
   * Summarize a conversation and append to memory.
   * Called before any session clear (expiry or /clear) so key facts survive.
   * Now uses importance scoring by default.
   */
  async flushSessionToMemory(
    history: ChatMessage[],
    botId: string,
    userId?: string
  ): Promise<void> {
    await this.flushWithScoring(history, botId, userId);
  }
}

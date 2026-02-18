import type { Context } from 'grammy';
import type { BotContext } from './types';

export class GroupActivation {
  constructor(private ctx: BotContext) {}

  /**
   * Check if the message explicitly @mentions another registered bot
   * and does NOT @mention this bot. Used for deterministic deference.
   */
  messageTargetsAnotherBot(ctx: Context, thisBotId: string): boolean {
    const entities = ctx.message?.entities ?? ctx.message?.caption_entities;
    const text = ctx.message?.text ?? ctx.message?.caption;
    if (!entities || !text) return false;

    for (const entity of entities) {
      if (entity.type === 'mention') {
        const mentionText = text.substring(entity.offset, entity.offset + entity.length);
        const username = mentionText.replace(/^@/, '');
        const agent = this.ctx.agentRegistry.getByTelegramUsername(username);
        if (agent && agent.botId !== thisBotId) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Build a context string listing other bots for multi-bot aware LLM checks.
   * Returns empty string if multiBotAware is disabled or no other agents exist.
   */
  getOtherBotsContext(thisBotId: string): string {
    if (!this.ctx.config.session.llmRelevanceCheck.multiBotAware) return '';
    const others = this.ctx.agentRegistry.listOtherAgents(thisBotId);
    if (others.length === 0) return '';
    const list = others
      .map((a) => `- ${a.name} (@${a.telegramUsername})${a.description ? ': ' + a.description : ''}`)
      .join('\n');
    return `\nOther bots in this group:\n${list}\n`;
  }

  /**
   * Ask the LLM whether a reply-window message is actually directed at the bot.
   * Returns true (respond) or false (skip). Fail-open: errors/timeouts return true.
   */
  async checkLlmRelevance(
    ctx: Context,
    botName: string,
    serializedKey: string,
    botId?: string
  ): Promise<boolean> {
    const rlc = this.ctx.config.session.llmRelevanceCheck;
    try {
      const recentHistory = this.ctx.sessionManager.getHistory(serializedKey, rlc.contextMessages);

      const contextBlock = recentHistory
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      const userText = ctx.message?.text ?? '';
      const otherBots = this.getOtherBotsContext(botId ?? '');

      const prompt = [
        `You are a classifier. The bot's name is "${botName}".`,
        otherBots,
        'Given the recent conversation and the new message, determine if the new message is directed at this bot or at someone else in the group.',
        'If the message mentions another bot by name or asks someone to talk to another bot, answer "no".',
        '',
        contextBlock ? `Recent conversation:\n${contextBlock}\n` : '',
        `New message: ${userText}`,
        '',
        'Is this message intended for this bot? Answer ONLY "yes" or "no".',
      ].filter(Boolean).join('\n');

      const result = await Promise.race([
        this.ctx.getLLMClient(botId ?? '').generate(prompt, {
          model: botId ? this.ctx.getActiveModel(botId) : this.ctx.config.ollama.models.primary,
          temperature: rlc.temperature,
        }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('LLM relevance check timeout')), rlc.timeout)
        ),
      ]);

      const answer = result.trim().toLowerCase();
      const isRelevant = answer.startsWith('yes');

      this.ctx.logger.info(
        {
          chatId: ctx.chat!.id,
          userId: ctx.from?.id,
          botId,
          answer,
          isRelevant,
          textPreview: userText.substring(0, 80),
        },
        'LLM relevance check result'
      );

      return isRelevant;
    } catch (err) {
      this.ctx.logger.warn({ err, chatId: ctx.chat?.id, botId }, 'LLM relevance check failed, fail-open');
      return true;
    }
  }

  /**
   * Ask the LLM whether a message with no prior activation context is directed
   * at this bot or at ALL bots (broadcast). Fail-closed: errors return false.
   */
  async checkBroadcastRelevance(
    ctx: Context,
    botName: string,
    botId: string
  ): Promise<boolean> {
    const rlc = this.ctx.config.session.llmRelevanceCheck;
    try {
      const userText = ctx.message?.text ?? '';
      const otherBots = this.getOtherBotsContext(botId);

      const prompt = [
        `You are a classifier. The bot's name is "${botName}".`,
        otherBots,
        'There are multiple bots in this group. Determine if this message is:',
        '- Directed specifically at this bot',
        '- Directed at ALL bots (e.g., "presentense", "bots", general questions to everyone)',
        '- Directed at someone else or at another bot',
        '',
        `Message: ${userText}`,
        '',
        'Answer "yes" only if the message is for this bot or for all bots. Answer "no" otherwise.',
      ].filter(Boolean).join('\n');

      const result = await Promise.race([
        this.ctx.getLLMClient(botId).generate(prompt, {
          model: this.ctx.getActiveModel(botId),
          temperature: rlc.temperature,
        }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Broadcast relevance check timeout')), rlc.timeout)
        ),
      ]);

      const answer = result.trim().toLowerCase();
      const isRelevant = answer.startsWith('yes');

      this.ctx.logger.info(
        {
          chatId: ctx.chat!.id,
          userId: ctx.from?.id,
          botId,
          answer,
          isRelevant,
          textPreview: userText.substring(0, 80),
        },
        'Broadcast relevance check result'
      );

      return isRelevant;
    } catch (err) {
      this.ctx.logger.warn({ err, chatId: ctx.chat?.id, botId }, 'Broadcast relevance check failed, fail-closed');
      return false;
    }
  }
}

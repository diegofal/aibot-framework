import type { Context } from 'grammy';
import type { BotConfig } from '../config';
import type { ConversationsService } from '../conversations/service';
import type { Logger } from '../logger';
import type { AskHumanStore } from './ask-human-store';
import type { GroupActivation } from './group-activation';
import type { BotContext } from './types';

/**
 * Result of evaluating the conversation gate.
 */
export interface ConversationGateResult {
  /** Whether the message should proceed to the conversation pipeline */
  allowed: boolean;
  /** Reason the message was blocked (for logging) */
  reason?: string;
  /** Stripped text (bot mention removed in groups) */
  strippedText?: string;
  /** Whether the sender is a peer bot (collaboration) */
  isPeerBotMessage?: boolean;
}

/**
 * ConversationGate encapsulates all pre-conditions that must pass before a
 * text message enters the conversation pipeline.
 *
 * Checks (in order):
 * 1. ask_human reply intercept
 * 2. Command guard (starts with /)
 * 3. Skill-consumed guard
 * 4. Bot-to-bot collaboration gate
 * 5. Auth check
 * 6. Group activation gate (deference, LLM relevance, broadcast)
 * 7. Strip bot mention in groups
 */
export class ConversationGate {
  constructor(
    private ctx: BotContext,
    private groupActivation: GroupActivation,
    private askHumanStore?: AskHumanStore,
    private conversationsService?: ConversationsService
  ) {}

  async evaluate(
    grammyCtx: Context & {
      message: { text: string; message_id: number; reply_to_message?: { message_id: number } };
      chat: { id: number; type: string };
      from: { id: number; username?: string; first_name?: string };
    },
    config: BotConfig,
    botLogger: Logger
  ): Promise<ConversationGateResult> {
    const text = grammyCtx.message.text;
    const chatId = grammyCtx.chat.id;
    const sessionConfig = this.ctx.config.session;

    // 1. ask_human reply intercept
    if (this.askHumanStore?.hasPending(config.id, chatId)) {
      const replyToId = grammyCtx.message.reply_to_message?.message_id;
      const replyResult = this.askHumanStore.handleReply(config.id, chatId, text, replyToId);
      if (replyResult.matched) {
        botLogger.info(
          { chatId, questionId: replyResult.questionId },
          'Message handled as ask_human reply'
        );
        // Write Telegram reply to the inbox conversation and mark answered
        if (replyResult.conversationId && replyResult.botId && this.conversationsService) {
          this.conversationsService.addMessage(
            replyResult.botId,
            replyResult.conversationId,
            'human',
            text
          );
          this.conversationsService.markInboxStatus(
            replyResult.botId,
            replyResult.conversationId,
            'answered'
          );
        }
        return { allowed: false, reason: 'ask_human_reply' };
      }
    }

    // 2. Command guard
    if (text.startsWith('/')) {
      botLogger.debug({ text }, 'Skipping: command message');
      return { allowed: false, reason: 'command' };
    }

    // 3. Skill-consumed guard
    if (this.ctx.handledMessageIds.delete(`${config.id}:${grammyCtx.message.message_id}`)) {
      botLogger.debug({ messageId: grammyCtx.message.message_id }, 'Skipping: consumed by skill');
      return { allowed: false, reason: 'skill_consumed' };
    }

    // 4. Bot-to-bot collaboration gate
    const collabConfig = this.ctx.config.collaboration;
    const senderAgent = grammyCtx.from?.id
      ? this.ctx.agentRegistry.getByTelegramUserId(grammyCtx.from.id)
      : undefined;
    let isPeerBotMessage = false;

    if (senderAgent) {
      if (!collabConfig.enabled) {
        botLogger.debug({ fromBot: senderAgent.botId }, 'Skipping: collaboration disabled');
        return { allowed: false, reason: 'collab_disabled' };
      }

      const botUsername = grammyCtx.me?.username;
      if (botUsername && !text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) {
        botLogger.debug(
          { fromBot: senderAgent.botId, text: text.substring(0, 80) },
          'Skipping bot message: no @mention of this bot'
        );
        return { allowed: false, reason: 'collab_no_mention' };
      }

      const check = this.ctx.collaborationTracker.checkAndRecord(
        senderAgent.botId,
        config.id,
        chatId
      );
      if (!check.allowed) {
        botLogger.info(
          { fromBot: senderAgent.botId, chatId, reason: check.reason },
          'Skipping bot message: collaboration limit'
        );
        return { allowed: false, reason: 'collab_limit' };
      }

      isPeerBotMessage = true;
      botLogger.info(
        { fromBot: senderAgent.botId, chatId },
        'Processing bot-to-bot message (collaboration)'
      );
    } else {
      // 5. Auth check (only for non-bot senders)
      if (!this.isAuthorized(grammyCtx.from?.id, config)) {
        botLogger.info(
          { userId: grammyCtx.from?.id, username: grammyCtx.from?.username },
          'Skipping: unauthorized user'
        );
        return { allowed: false, reason: 'unauthorized' };
      }
    }

    const isGroup = grammyCtx.chat.type === 'group' || grammyCtx.chat.type === 'supergroup';
    const botUsername = grammyCtx.me?.username;
    const chatTitle =
      'title' in grammyCtx.chat ? (grammyCtx.chat as { title?: string }).title : undefined;

    // 6. Group activation gate
    if (isGroup && sessionConfig.enabled && !isPeerBotMessage) {
      const gateResult = await this.evaluateGroupGate(
        grammyCtx,
        config,
        botLogger,
        botUsername,
        chatTitle
      );
      if (!gateResult.allowed) return gateResult;
    }

    // 7. Strip bot mention in groups
    let strippedText = text;
    if (isGroup && botUsername) {
      strippedText = this.ctx.sessionManager.stripBotMention(
        text,
        botUsername,
        config.mentionPatterns
      );
    }

    return { allowed: true, strippedText, isPeerBotMessage };
  }

  private async evaluateGroupGate(
    grammyCtx: Context & {
      message: { text: string };
      chat: { id: number; type: string };
      from: { id: number; username?: string; first_name?: string };
    },
    config: BotConfig,
    botLogger: Logger,
    botUsername: string | undefined,
    chatTitle: string | undefined
  ): Promise<ConversationGateResult> {
    const sessionConfig = this.ctx.config.session;
    const chatId = grammyCtx.chat.id;

    let groupReason = this.ctx.sessionManager.shouldRespondInGroup(
      grammyCtx,
      botUsername,
      config.id,
      config.mentionPatterns
    );

    if (groupReason && groupReason !== 'mention' && groupReason !== 'replyToBot') {
      if (this.groupActivation.messageTargetsAnotherBot(grammyCtx, config.id)) {
        botLogger.info(
          { chatId, chatTitle, firstName: grammyCtx.from?.first_name, reason: groupReason },
          'Deferring to @mentioned bot'
        );
        return { allowed: false, reason: 'deference' };
      }
    }

    if (groupReason === 'replyWindow' && sessionConfig.llmRelevanceCheck.enabled) {
      const sessionKey = this.ctx.sessionManager.deriveKey(config.id, grammyCtx);
      const serializedKey = this.ctx.sessionManager.serializeKey(sessionKey);
      const isRelevant = await this.groupActivation.checkLlmRelevance(
        grammyCtx,
        config.name,
        serializedKey,
        config.id
      );
      if (!isRelevant) {
        botLogger.info(
          {
            chatId,
            chatTitle,
            userId: grammyCtx.from?.id,
            firstName: grammyCtx.from?.first_name,
            text: grammyCtx.message.text.substring(0, 80),
          },
          'Skipping group message: LLM relevance check said no'
        );
        return { allowed: false, reason: 'llm_irrelevant' };
      }
    }

    if (
      !groupReason &&
      sessionConfig.llmRelevanceCheck.enabled &&
      sessionConfig.llmRelevanceCheck.broadcastCheck
    ) {
      const shouldRespond = await this.groupActivation.checkBroadcastRelevance(
        grammyCtx,
        config.name,
        config.id
      );
      if (shouldRespond) {
        groupReason = 'broadcast';
      }
    }

    if (!groupReason) {
      botLogger.info(
        {
          chatId,
          chatTitle,
          userId: grammyCtx.from?.id,
          firstName: grammyCtx.from?.first_name,
          text: grammyCtx.message.text.substring(0, 80),
          botUsername,
          mentionPatterns: config.mentionPatterns,
        },
        'Skipping group message: no mention/reply/active window'
      );
      return { allowed: false, reason: 'group_inactive' };
    }

    botLogger.info(
      { chatId, chatTitle, firstName: grammyCtx.from?.first_name, reason: groupReason },
      'Group activation gate passed'
    );

    return { allowed: true };
  }

  private isAuthorized(userId: number | undefined, config: BotConfig): boolean {
    if (!userId) return false;
    if (!config.authorizedUsers || config.authorizedUsers.length === 0) return true;
    return config.authorizedUsers.includes(userId);
  }
}

import type { AgentInfo } from '../agent-registry';
import type { BotConfig } from '../config';
import { resolveAgentConfig } from '../config';
import type { ChatMessage } from '../ollama';
import type { BotContext } from './types';
import type { SystemPromptBuilder } from './system-prompt-builder';
import type { ToolRegistry } from './tool-registry';
import { sendLongMessage } from './telegram-utils';
import { ToolExecutor } from './tool-executor';

export class CollaborationManager {
  constructor(
    private ctx: BotContext,
    private systemPromptBuilder: SystemPromptBuilder,
    private toolRegistry: ToolRegistry,
  ) {}

  /**
   * Send a visible collaboration message in a group chat, mentioning the target bot.
   */
  async sendVisibleMessage(chatId: number, sourceBotId: string, targetBotId: string, message: string): Promise<void> {
    const bot = this.ctx.bots.get(sourceBotId);
    if (!bot) throw new Error(`Source bot has no Telegram instance (headless?): ${sourceBotId}`);

    let agent = this.ctx.agentRegistry.getByBotId(targetBotId);
    const resolvedTargetId = agent ? targetBotId : this.ctx.resolveBotId(targetBotId);
    if (!agent && resolvedTargetId) {
      agent = this.ctx.agentRegistry.getByBotId(resolvedTargetId);
    }
    if (!agent || !resolvedTargetId) throw new Error(`Target agent not found: ${targetBotId}`);

    const visibleText = `@${agent.telegramUsername} ${message}`;
    await sendLongMessage(t => bot.api.sendMessage(chatId, t), visibleText);

    const sourceLogger = this.ctx.getBotLogger(sourceBotId);
    sourceLogger.info(
      { chatId, sourceBotId, targetBotId: resolvedTargetId, targetUsername: agent.telegramUsername },
      'Visible collaboration message sent'
    );

    this.processVisibleResponse(chatId, resolvedTargetId, sourceBotId, message).catch((err) => {
      sourceLogger.error({ err, chatId, targetBotId: resolvedTargetId }, 'Failed to process visible collaboration response');
    });
  }

  /**
   * Run a single visible-discussion turn: generate one response from a bot.
   */
  private async runVisibleTurn(
    chatId: number,
    respondingBotId: string,
    transcript: Array<{ botId: string; text: string }>,
  ): Promise<string> {
    const respondingConfig = this.ctx.config.bots.find((b) => b.id === respondingBotId);
    if (!respondingConfig) throw new Error(`Bot config not found: ${respondingBotId}`);

    const resolved = resolveAgentConfig(this.ctx.config, respondingConfig);

    // Build system prompt via unified builder (collaboration mode)
    const systemPrompt = this.systemPromptBuilder.build({
      mode: 'collaboration',
      botId: respondingBotId,
      botConfig: respondingConfig,
      isGroup: true,
    });

    // Get the responding bot's regular group session history
    const serializedKey = `bot:${respondingBotId}:group:${chatId}`;
    const history = this.ctx.config.session.enabled
      ? this.ctx.sessionManager.getHistory(serializedKey, resolved.maxHistory)
      : [];

    // Map transcript to user/assistant messages from this bot's perspective
    const transcriptMessages: ChatMessage[] = transcript.map((entry) => {
      if (entry.botId === respondingBotId) {
        return { role: 'assistant' as const, content: entry.text };
      }
      const otherConfig = this.ctx.config.bots.find((b) => b.id === entry.botId);
      const otherName = otherConfig?.name ?? entry.botId;
      return { role: 'user' as const, content: `[${otherName}]: ${entry.text}` };
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      ...transcriptMessages,
    ];

    // Use collaboration-safe tools (filtered per bot)
    const { tools: collabTools, definitions: collabDefs } = this.toolRegistry.getCollaborationToolsForBot(respondingBotId);
    const hasTools = collabDefs.length > 0;

    // Create executor with collaboration filter
    const executor = hasTools
      ? new ToolExecutor(this.ctx, {
          botId: respondingBotId,
          chatId,
          tools: collabTools,
          toolFilter: () => true, // Already filtered by collabTools
        }).createCallback()
      : undefined;

    return this.ctx.getLLMClient(respondingBotId).chat(messages, {
      model: this.ctx.getActiveModel(respondingBotId),
      temperature: resolved.temperature,
      tools: hasTools ? collabDefs : undefined,
      toolExecutor: executor,
      maxToolRounds: this.ctx.config.webTools?.maxToolRounds,
    });
  }

  /**
   * Drive a multi-turn visible discussion between two bots in a group chat.
   */
  private async processVisibleResponse(
    chatId: number,
    targetBotId: string,
    sourceBotId: string,
    message: string,
  ): Promise<void> {
    const visibleMaxTurns = this.ctx.config.collaboration.visibleMaxTurns;
    const botLogger = this.ctx.getBotLogger(targetBotId);
    const transcript: Array<{ botId: string; text: string }> = [];

    transcript.push({ botId: sourceBotId, text: message });

    for (let turn = 0; turn < visibleMaxTurns; turn++) {
      const respondingBotId = turn % 2 === 0 ? targetBotId : sourceBotId;
      const respondingBot = this.ctx.bots.get(respondingBotId);
      if (!respondingBot) break;

      try { await respondingBot.api.sendChatAction(chatId, 'typing'); } catch { /* ignore */ }

      const response = await this.runVisibleTurn(chatId, respondingBotId, transcript);
      transcript.push({ botId: respondingBotId, text: response });

      // Persist to responding bot's group session
      const prevEntry = transcript[transcript.length - 2];
      const prevBotConfig = this.ctx.config.bots.find((b) => b.id === prevEntry.botId);
      const prevName = prevBotConfig?.name ?? prevEntry.botId;
      const serializedKey = `bot:${respondingBotId}:group:${chatId}`;
      const respondingConfig = this.ctx.config.bots.find((b) => b.id === respondingBotId)!;
      const resolved = resolveAgentConfig(this.ctx.config, respondingConfig);
      if (this.ctx.config.session.enabled) {
        this.ctx.sessionManager.appendMessages(serializedKey, [
          { role: 'user', content: `[${prevName}]: ${prevEntry.text}` },
          { role: 'assistant', content: response },
        ], resolved.maxHistory);
      }

      if (response.trim()) {
        await sendLongMessage(t => respondingBot.api.sendMessage(chatId, t), response);
      }

      botLogger.info(
        { chatId, respondingBotId, turn, totalTurns: visibleMaxTurns, responseLength: response.length },
        'Visible discussion turn'
      );
    }

    botLogger.info(
      { chatId, sourceBotId, targetBotId, turns: transcript.length - 1 },
      'Visible discussion completed'
    );
  }

  /**
   * Handle a delegation request from one bot to another.
   * Runs the target bot's LLM WITHOUT tools to prevent loops.
   */
  async handleDelegation(
    targetBotId: string,
    chatId: number,
    message: string,
    sourceBotId: string
  ): Promise<string> {
    const resolvedId = this.ctx.resolveBotId(targetBotId);
    if (!resolvedId) {
      throw new Error(`Target bot not running: ${targetBotId}`);
    }
    targetBotId = resolvedId;

    const targetBot = this.ctx.bots.get(targetBotId);
    const targetConfig = this.ctx.config.bots.find((b) => b.id === targetBotId);
    if (!targetConfig) {
      throw new Error(`Target bot config not found: ${targetBotId}`);
    }

    const resolved = resolveAgentConfig(this.ctx.config, targetConfig);
    const targetSoulLoader = this.ctx.getSoulLoader(targetBotId);
    const botLogger = this.ctx.getBotLogger(targetBotId);

    let systemPrompt = targetSoulLoader.composeSystemPrompt() ?? resolved.systemPrompt;

    const sourceConfig = this.ctx.config.bots.find((b) => b.id === sourceBotId);
    const sourceName = sourceConfig?.name ?? sourceBotId;
    systemPrompt += `\n\n${sourceName} has delegated a message to you. Respond as yourself.`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];

    botLogger.info(
      { targetBotId, sourceBotId, chatId, messagePreview: message.substring(0, 120) },
      'Handling delegation'
    );

    const response = await this.ctx.getLLMClient(targetBotId).chat(messages, {
      model: this.ctx.getActiveModel(targetBotId),
      temperature: resolved.temperature,
    });

    if (response.trim() && targetBot) {
      await sendLongMessage(t => targetBot.api.sendMessage(chatId, t), response);
    } else if (response.trim()) {
      botLogger.info({ targetBotId, chatId }, 'Delegation response generated but bot is headless, skipping Telegram send');
    }

    botLogger.info(
      { targetBotId, chatId, responseLength: response.length },
      'Delegation response sent'
    );

    return response;
  }

  /**
   * Discover agents with their full capabilities (tools, model, skills).
   */
  discoverAgents(excludeBotId: string): Array<AgentInfo & { model?: string }> {
    const agents = this.ctx.agentRegistry.listOtherAgents(excludeBotId);
    return agents.map((a) => ({
      ...a,
      model: this.ctx.activeModels.get(a.botId),
    }));
  }

  /**
   * Run a single collaboration step: send a message to a target bot's LLM
   * with session history and (optionally) tools enabled.
   */
  async collaborationStep(
    sessionId: string | undefined,
    targetBotId: string,
    message: string,
    sourceBotId: string,
  ): Promise<{ sessionId: string; response: string }> {
    const resolvedId = this.ctx.resolveBotId(targetBotId);
    if (!resolvedId) {
      throw new Error(`Target bot not running: ${targetBotId}`);
    }
    targetBotId = resolvedId;

    const targetConfig = this.ctx.config.bots.find((b) => b.id === targetBotId);
    if (!targetConfig) {
      throw new Error(`Target bot config not found: ${targetBotId}`);
    }

    const check = this.ctx.collaborationTracker.checkAndRecord(sourceBotId, targetBotId, 0);
    if (!check.allowed) {
      throw new Error(`Collaboration blocked: ${check.reason}`);
    }

    const collabConfig = this.ctx.config.collaboration;
    const resolved = resolveAgentConfig(this.ctx.config, targetConfig);
    const targetSoulLoader = this.ctx.getSoulLoader(targetBotId);
    const botLogger = this.ctx.getBotLogger(targetBotId);

    let session = sessionId ? this.ctx.collaborationSessions.get(sessionId) : undefined;
    if (!session) {
      session = this.ctx.collaborationSessions.create(sourceBotId, targetBotId);
    }

    let systemPrompt = targetSoulLoader.composeSystemPrompt() ?? resolved.systemPrompt;
    const sourceConfig = this.ctx.config.bots.find((b) => b.id === sourceBotId);
    const sourceName = sourceConfig?.name ?? sourceBotId;
    systemPrompt += `\n\nAnother agent ("${sourceName}") is collaborating with you internally. Answer concisely and helpfully.`;

    const userMessage: ChatMessage = { role: 'user', content: message };
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...session.messages,
      userMessage,
    ];

    const useTools = collabConfig.enableTargetTools;
    const collabTools = useTools ? this.toolRegistry.getCollaborationToolsForBot(targetBotId) : { tools: [], definitions: [] };
    const hasTools = collabTools.definitions.length > 0;

    // Create executor with collaboration filter
    const executor = hasTools
      ? new ToolExecutor(this.ctx, {
          botId: targetBotId,
          chatId: 0,
          tools: collabTools.tools,
          toolFilter: () => true, // Already filtered by collabTools
        }).createCallback()
      : undefined;

    botLogger.info(
      {
        sessionId: session.id,
        targetBotId,
        sourceBotId,
        historyLength: session.messages.length,
        toolsEnabled: hasTools,
        messagePreview: message.substring(0, 120),
      },
      'Collaboration step'
    );

    const timeout = collabConfig.internalQueryTimeout;
    const response = await Promise.race([
      this.ctx.getLLMClient(targetBotId).chat(messages, {
        model: this.ctx.getActiveModel(targetBotId),
        temperature: resolved.temperature,
        tools: hasTools ? collabTools.definitions : undefined,
        toolExecutor: executor,
        maxToolRounds: this.ctx.config.webTools?.maxToolRounds,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Collaboration step timeout')), timeout)
      ),
    ]);

    this.ctx.collaborationSessions.appendMessages(session.id, [
      userMessage,
      { role: 'assistant', content: response },
    ]);

    botLogger.info(
      { sessionId: session.id, targetBotId, responseLength: response.length },
      'Collaboration step completed'
    );

    return { sessionId: session.id, response };
  }

  /**
   * Programmatic API: run an autonomous multi-turn collaboration between two bots.
   */
  async initiateCollaboration(
    sourceBotId: string,
    targetBotId: string,
    topic: string,
    maxTurns?: number,
  ): Promise<{ sessionId: string; transcript: string; turns: number }> {
    const collabConfig = this.ctx.config.collaboration;
    const turns = maxTurns ?? collabConfig.maxConverseTurns;
    const botLogger = this.ctx.getBotLogger(sourceBotId);

    const sourceConfig = this.ctx.config.bots.find((b) => b.id === sourceBotId);
    if (!sourceConfig) throw new Error(`Source bot config not found: ${sourceBotId}`);
    if (!this.ctx.runningBots.has(sourceBotId)) throw new Error(`Source bot not running: ${sourceBotId}`);

    const resolved = resolveAgentConfig(this.ctx.config, sourceConfig);
    const sourceSoulLoader = this.ctx.getSoulLoader(sourceBotId);

    let sourceSystemPrompt = sourceSoulLoader.composeSystemPrompt() ?? resolved.systemPrompt;
    const targetConfig = this.ctx.config.bots.find((b) => b.id === targetBotId);
    const targetName = targetConfig?.name ?? targetBotId;
    sourceSystemPrompt +=
      `\n\nYou are collaborating with "${targetName}" on a topic. ` +
      'Evaluate their responses and continue the conversation until you are satisfied. ' +
      'When you have enough information or the task is complete, include [DONE] in your response.';

    let sessionId: string | undefined;
    let currentMessage = topic;
    const transcriptLines: string[] = [];
    let turnCount = 0;

    for (let i = 0; i < turns; i++) {
      const step = await this.collaborationStep(sessionId, targetBotId, currentMessage, sourceBotId);
      sessionId = step.sessionId;
      transcriptLines.push(`[${sourceBotId}]: ${currentMessage}`);
      transcriptLines.push(`[${targetBotId}]: ${step.response}`);
      turnCount = i + 1;

      if (i < turns - 1) {
        const evalMessages: ChatMessage[] = [
          { role: 'system', content: sourceSystemPrompt },
          ...transcriptLines.map((line) => {
            const isSource = line.startsWith(`[${sourceBotId}]`);
            return {
              role: (isSource ? 'assistant' : 'user') as ChatMessage['role'],
              content: line.replace(/^\[[^\]]+\]: /, ''),
            };
          }),
        ];

        const timeout = collabConfig.internalQueryTimeout;
        const sourceResponse = await Promise.race([
          this.ctx.getLLMClient(sourceBotId).chat(evalMessages, {
            model: this.ctx.getActiveModel(sourceBotId),
            temperature: resolved.temperature,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Collaboration source timeout')), timeout)
          ),
        ]);

        transcriptLines.push(`[${sourceBotId}]: ${sourceResponse}`);

        if (sourceResponse.includes('[DONE]')) {
          botLogger.info({ sessionId, turns: turnCount }, 'Collaboration ended by source ([DONE])');
          break;
        }

        currentMessage = sourceResponse;
      }
    }

    botLogger.info(
      { sessionId, sourceBotId, targetBotId, turns: turnCount },
      'Collaboration completed'
    );

    if (sessionId) {
      this.ctx.collaborationSessions.end(sessionId);
    }

    return {
      sessionId: sessionId!,
      transcript: transcriptLines.join('\n'),
      turns: turnCount,
    };
  }
}

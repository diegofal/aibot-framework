import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Bot } from 'grammy';
import type { AskHumanStore, PendingQuestionInfo } from '../bot/ask-human-store';
import type { OperatorConfig } from '../config';
import type { ConversationsService } from '../conversations/service';
import type { Logger } from '../logger';
import type { FileRef } from '../types/thread';
import { OPERATOR_CHAT_ALIAS, resolveOperatorTarget } from './send-proactive-message';
import type { Tool, ToolResult } from './types';

/**
 * Protocol limits, chosen from ten days of inbox data (27 asks, 20 closed
 * unanswered): every ask that got an answer was at or under 600 characters and
 * asked exactly one thing; the long ones with file inventories never did. A
 * pending ask nobody has answered in three days is not going to be answered,
 * and leaving it open blocks the bot from asking anything else.
 */
export const ASK_HUMAN_DEFAULTS = { maxChars: 600, autoCloseHours: 72 } as const;

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_OPTION_CHARS = 80;
const HOUR_MS = 3_600_000;

/** How much of the question the operator ping carries; the inbox has the rest. */
export const OPERATOR_ASK_PREVIEW_CHARS = 300;

export interface AskHumanDeps {
  store: AskHumanStore;
  getBotInstance: (botId: string) => Bot | undefined;
  getBotName: (botId: string) => string;
  conversationsService?: ConversationsService;
  /** Appends one line to the bot's daily memory (SoulLoader.appendDailyMemory). */
  appendDailyMemory?: (botId: string, note: string) => void;
  /** `config.askHuman.maxChars`; defaults to 600. */
  maxChars?: number;
  /** `config.askHuman.autoCloseHours`; defaults to 72. */
  autoCloseHours?: number;
  /**
   * Operator contact from `config.operator`; omitted means "not configured".
   * Same shape as SendProactiveMessageDeps.getOperator so both tools resolve
   * the operator through `resolveOperatorTarget`.
   */
  getOperator?: () => OperatorConfig | undefined;
  /**
   * Delivers the `notifyOnAsk` ping to the operator. Injected so a headless
   * bot (no Telegram instance of its own — seven of eight in the fleet) can
   * still reach the operator through any live instance, and so tests can
   * capture the message. Without it the asking bot's own instance is used.
   * S9 adds web push on this same hook.
   */
  notifyOperator?: OperatorNotifier;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface OperatorNotification {
  chatId: number;
  /** The bot that asked; the sender may deliver through another one. */
  botId: string;
  text: string;
}

export type OperatorNotifier = (msg: OperatorNotification) => Promise<void>;

/**
 * The fleet-wide sender BotManager wires: the asking bot's own Telegram
 * instance when it has one, else any live instance in the fleet (the same
 * resolution cron instructions and `send_proactive_message` use). Throws
 * when there is none at all; `notifyOperatorOfAsk` logs that and moves on.
 */
export function createFleetOperatorNotifier(
  getBot: (botId: string) => Bot | undefined,
  getAnyBot: () => Bot | undefined
): OperatorNotifier {
  return async ({ chatId, botId, text }) => {
    const bot = getBot(botId) ?? getAnyBot();
    if (!bot) {
      throw new Error('No live Telegram instance in the fleet to reach the operator');
    }
    await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  };
}

/**
 * The message the operator gets when `config.operator.notifyOnAsk` is on.
 * Deliberately short: the full question, files and the answer buttons live in
 * the dashboard inbox — this only exists so the operator does not have to poll it.
 */
export function buildOperatorAskNotification(
  botName: string,
  question: string,
  options?: string[]
): string {
  const preview =
    question.length > OPERATOR_ASK_PREVIEW_CHARS
      ? `${question.slice(0, OPERATOR_ASK_PREVIEW_CHARS - 3)}...`
      : question;
  const optionsLine = options?.length ? `\n\nOptions: ${options.join(' | ')}` : '';
  return `📥 **${botName} queued a question for you:**\n\n${preview}${optionsLine}\n\n_Answer it in the dashboard inbox._`;
}

function truncateTitle(question: string): string {
  return question.length > 60 ? `${question.slice(0, 57)}...` : question;
}

type OptionsCheck = { ok: true; options?: string[] } | { ok: false; error: string };

function validateOptions(raw: unknown): OptionsCheck {
  if (raw === undefined || raw === null) return { ok: true };
  const error =
    `Invalid options: provide ${MIN_OPTIONS}-${MAX_OPTIONS} short strings ` +
    `(each 1-${MAX_OPTION_CHARS} chars) for quick-reply buttons, or omit options.`;
  if (!Array.isArray(raw) || raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) {
    return { ok: false, error };
  }
  const options: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error };
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > MAX_OPTION_CHARS) return { ok: false, error };
    options.push(trimmed);
  }
  return { ok: true, options };
}

/**
 * Close pending asks older than `autoCloseHours`: the inbox conversation is
 * marked `closed` and the bot gets a daily-memory line so it knows the
 * question went unanswered rather than believing it is still waiting.
 *
 * Runs on every ask_human invocation (scoped to the calling bot) and is
 * exported so a periodic sweep can call it across all bots.
 */
export function sweepStaleAskHumanQuestions(
  deps: AskHumanDeps,
  logger: Logger,
  botId?: string
): PendingQuestionInfo[] {
  const hours = deps.autoCloseHours ?? ASK_HUMAN_DEFAULTS.autoCloseHours;
  const now = (deps.now ?? Date.now)();
  const closed = deps.store.closeStale(hours * HOUR_MS, now, botId);

  for (const q of closed) {
    if (deps.conversationsService && q.conversationId) {
      try {
        deps.conversationsService.markInboxStatus(q.botId, q.conversationId, 'closed');
      } catch (err) {
        logger.warn(
          { err, questionId: q.id, conversationId: q.conversationId },
          'ask_human: failed to mark auto-closed conversation (non-fatal)'
        );
      }
    }
    const note = `[ask_human] Question auto-closed after ${hours}h without answer: ${truncateTitle(q.question)}`;
    try {
      deps.appendDailyMemory?.(q.botId, note);
    } catch (err) {
      logger.warn({ err, questionId: q.id }, 'ask_human: failed to write memory note (non-fatal)');
    }
    logger.info(
      { questionId: q.id, botId: q.botId, ageHours: Math.round((now - q.createdAt) / HOUR_MS) },
      'ask_human: question auto-closed without answer'
    );
  }
  closeStaleInboxConversations(deps, logger, botId);
  return closed;
}

/**
 * Close inbox conversations still `pending` that are older than
 * `autoCloseHours` and have no live question in the store (a lost store file,
 * an ask that never got a question id). Startup reconcile restores most of
 * them, but anything that slips past it — or goes orphan between restarts —
 * used to stay in Needs You until the next boot. Writes the same memory note
 * as a store auto-close. A thread that already carries a human message is
 * marked `answered` instead (same rule as reconcile). Never throws.
 */
export function closeStaleInboxConversations(
  deps: AskHumanDeps,
  logger: Logger,
  botId?: string
): import('../conversations/service').Conversation[] {
  const conversations = deps.conversationsService;
  if (!conversations) return [];
  const hours = deps.autoCloseHours ?? ASK_HUMAN_DEFAULTS.autoCloseHours;
  const now = (deps.now ?? Date.now)();
  const closed: import('../conversations/service').Conversation[] = [];
  let botIds: string[];
  try {
    botIds = botId ? [botId] : conversations.getBotIds();
  } catch (err) {
    logger.warn({ err }, 'ask_human: failed to list inbox bots for the sweep (non-fatal)');
    return [];
  }
  for (const id of botIds) {
    try {
      const live = new Set(deps.store.getPendingForBot(id).map((q) => q.id));
      const inbox = conversations.listConversations(id, {
        type: 'inbox',
        limit: Number.MAX_SAFE_INTEGER,
      });
      for (const conv of inbox) {
        if (conv.inboxStatus !== 'pending') continue;
        if (conv.askHumanQuestionId && live.has(conv.askHumanQuestionId)) continue;
        const created = Date.parse(conv.createdAt);
        if (!Number.isFinite(created) || now - created <= hours * HOUR_MS) continue;
        // Same rule as reconcileAskHumanInbox: a thread carrying a human
        // message was answered in chat — never close it "without answer".
        if (conversations.getMessages(id, conv.id).some((m) => m.role === 'human')) {
          conversations.markInboxStatus(id, conv.id, 'answered');
          continue;
        }
        const updated = conversations.markInboxStatus(id, conv.id, 'closed');
        if (!updated) continue;
        closed.push(updated);
        try {
          deps.appendDailyMemory?.(
            id,
            `[ask_human] Question auto-closed after ${hours}h without answer: ${truncateTitle(conv.title)}`
          );
        } catch (err) {
          logger.warn(
            { err, conversationId: conv.id },
            'ask_human: failed to write memory note (non-fatal)'
          );
        }
      }
    } catch (err) {
      logger.warn({ err, botId: id }, 'ask_human: failed to sweep inbox conversations (non-fatal)');
    }
  }
  if (closed.length > 0) {
    logger.info(
      { count: closed.length, botId: botId ?? null },
      'ask_human: orphaned inbox conversations auto-closed without answer'
    );
  }
  return closed;
}

/** How much of the operator's answer the daily-memory note keeps. */
export const ANSWER_NOTE_MAX_CHARS = 500;

/**
 * Daily-memory line written when the operator answers an ask. The planner gets
 * the answer once through `answeredQuestions`; this line is the durable copy:
 * it reaches the strategist (seven days of daily logs), survives a planner
 * failure after the answer was consumed, and gets consolidated into MEMORY.md.
 */
export function buildAskHumanAnswerNote(question: string, answer: string): string {
  const flat = answer.replace(/\s+/g, ' ').trim();
  const clipped =
    flat.length > ANSWER_NOTE_MAX_CHARS ? `${flat.slice(0, ANSWER_NOTE_MAX_CHARS - 3)}...` : flat;
  return `[ask_human] Operator answered "${truncateTitle(question.replace(/\s+/g, ' ').trim())}": ${clipped}`;
}

export interface ReconcileInboxResult {
  /** Orphaned pending asks put back in the store (sweepable, answerable). */
  restored: number;
  /** Orphans the operator had already replied to in chat, marked `answered`. */
  markedAnswered: number;
}

/**
 * Re-attach inbox conversations still marked `pending` whose question the
 * store does not hold — asks from before pending questions were persisted, or
 * from a store file that was lost. Without this they stay `pending` forever:
 * the 72 h sweep never sees them, the Needs-You answer button 404s and a reply
 * typed in the thread falls through to plain chat instead of reaching the planner.
 *
 * An orphan that already carries a human message was answered in chat; it is
 * marked `answered` rather than re-queued (the bot replied in that thread).
 * Everything else is restored with the conversation's own `createdAt`, so the
 * next sweep closes the stale ones and writes the usual memory note.
 */
export function reconcileAskHumanInbox(deps: AskHumanDeps, logger: Logger): ReconcileInboxResult {
  const result: ReconcileInboxResult = { restored: 0, markedAnswered: 0 };
  const conversations = deps.conversationsService;
  if (!conversations) return result;

  for (const botId of conversations.getBotIds()) {
    const pendingIds = new Set(deps.store.getPendingForBot(botId).map((q) => q.id));
    const inbox = conversations.listConversations(botId, {
      type: 'inbox',
      limit: Number.MAX_SAFE_INTEGER,
    });
    for (const conv of inbox) {
      if (conv.inboxStatus !== 'pending' || !conv.askHumanQuestionId) continue;
      if (pendingIds.has(conv.askHumanQuestionId)) continue;
      try {
        const messages = conversations.getMessages(botId, conv.id);
        if (messages.some((m) => m.role === 'human')) {
          conversations.markInboxStatus(botId, conv.id, 'answered');
          result.markedAnswered++;
          continue;
        }
        const question = messages.find((m) => m.role === 'bot')?.content ?? conv.title;
        const createdAt = Date.parse(conv.createdAt);
        const restored = deps.store.restorePending({
          id: conv.askHumanQuestionId,
          botId,
          chatId: 0,
          question,
          conversationId: conv.id,
          ...(conv.askOptions && conv.askOptions.length > 0 ? { options: conv.askOptions } : {}),
          createdAt: Number.isFinite(createdAt) ? createdAt : (deps.now ?? Date.now)(),
        });
        if (restored) result.restored++;
      } catch (err) {
        logger.warn(
          { err, botId, conversationId: conv.id },
          'ask_human: failed to reconcile orphaned inbox conversation (non-fatal)'
        );
      }
    }
  }

  if (result.restored > 0 || result.markedAnswered > 0) {
    logger.info(result, 'ask_human: reconciled orphaned pending inbox conversations');
  }
  return result;
}

/**
 * Notify `config.operator.telegramChatId` that a question was queued.
 *
 * No-op unless `operator.notifyOnAsk === true` and a chat id is configured.
 * Never throws and never affects the ask: the question is already in the
 * inbox by the time this runs, so a Telegram failure is logged at warn and
 * swallowed, exactly like the asking bot's own notification.
 */
async function notifyOperatorOfAsk(
  deps: AskHumanDeps,
  logger: Logger,
  ask: {
    botId: string;
    question: string;
    options?: string[];
    questionId: string;
    alreadyNotified: Set<number>;
  }
): Promise<void> {
  const operator = deps.getOperator?.();
  if (!operator?.notifyOnAsk) return;

  const target = resolveOperatorTarget(OPERATOR_CHAT_ALIAS, operator);
  const operatorChatId = target.kind === 'operator' ? target.chatId : undefined;
  if (!operatorChatId) {
    logger.warn(
      { botId: ask.botId, questionId: ask.questionId },
      'ask_human: operator.notifyOnAsk is on but operator.telegramChatId is not configured'
    );
    return;
  }
  // The asking bot already wrote into that chat — one ping, not two.
  if (ask.alreadyNotified.has(operatorChatId)) return;

  const text = buildOperatorAskNotification(deps.getBotName(ask.botId), ask.question, ask.options);
  let send = deps.notifyOperator;
  if (!send) {
    // Legacy path: only the asking bot's own instance can deliver.
    const bot = deps.getBotInstance(ask.botId);
    if (!bot) return;
    send = async (msg) => {
      await bot.api.sendMessage(msg.chatId, msg.text, { parse_mode: 'Markdown' });
    };
  }

  try {
    await send({ chatId: operatorChatId, botId: ask.botId, text });
    logger.info(
      { botId: ask.botId, questionId: ask.questionId, chatId: operatorChatId },
      'ask_human: operator notified of the queued question'
    );
  } catch (err) {
    logger.warn(
      { botId: ask.botId, questionId: ask.questionId, chatId: operatorChatId, err },
      'ask_human: failed to notify the operator, question still queued in inbox'
    );
  }
}

/**
 * Tool that lets the bot ask the human operator a question.
 * The question is queued to the web inbox and returns immediately (non-blocking).
 * The answer will be injected into the bot's next agent loop cycle.
 */
export function createAskHumanTool(deps: AskHumanDeps): Tool {
  const maxChars = deps.maxChars ?? ASK_HUMAN_DEFAULTS.maxChars;
  const autoCloseHours = deps.autoCloseHours ?? ASK_HUMAN_DEFAULTS.autoCloseHours;

  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_human',
        description: [
          'Ask the human operator a question. The question is queued in the web inbox (non-blocking).',
          'Use when you need information, approval, or a decision that you cannot determine on your own.',
          'The answer will be delivered to you in your next cycle. Continue working on other tasks in the meantime.',
          `Protocol: at most ${maxChars} characters, exactly ONE question, and ideally 2-4 short options`,
          'the operator can pick with a button. Put long context in a file and reference it via "files".',
          `A question nobody answers within ${autoCloseHours}h is auto-closed; only one question can be pending at a time.`,
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: `The single question to ask the human operator (max ${maxChars} characters)`,
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Optional 2-4 short answer choices (max 80 chars each) shown as quick-reply buttons, e.g. ["Yes", "No", "Later"]',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description:
                'File paths relevant to this question (relative to your working directory)',
            },
          },
          required: ['question'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      const botId = args._botId as string;
      const chatId = (args._chatId as number) || 0;

      if (!question) {
        return { success: false, content: 'Missing required parameter: question' };
      }
      if (!botId) {
        return {
          success: false,
          content: 'ask_human requires _botId (only available in agent loop)',
        };
      }

      if (question.length > maxChars) {
        return {
          success: false,
          content: [
            `Question too long (${question.length} chars, max ${maxChars}).`,
            'Shorten it and ask exactly one thing — short single-question asks get answered,',
            'long ones with file inventories do not. Put details in a file and reference it via "files".',
          ].join(' '),
        };
      }

      const optionsCheck = validateOptions(args.options);
      if (!optionsCheck.ok) {
        return { success: false, content: optionsCheck.error };
      }
      const options = optionsCheck.options;

      // A forgotten ask must not block this bot forever.
      sweepStaleAskHumanQuestions(deps, logger, botId);

      const pending = deps.store.getPendingForBot(botId)[0];
      if (pending) {
        const ageHours = Math.floor(((deps.now ?? Date.now)() - pending.createdAt) / HOUR_MS);
        return {
          success: true,
          content: [
            `You already have a pending question in the inbox (asked ${ageHours}h ago;`,
            `it auto-closes after ${autoCloseHours}h without an answer).`,
            'Wait for the human to respond before asking again.',
          ].join(' '),
        };
      }

      // Register the question in the store (always works — visible in web inbox)
      const { id, promise } = deps.store.ask(
        botId,
        chatId,
        question,
        options,
        (deps.now ?? Date.now)()
      );
      promise.catch((err) => {
        logger.info(
          { questionId: id, botId, reason: err.message },
          'ask_human: question closed without answer'
        );
      });

      // Resolve file references
      const rawFiles = Array.isArray(args.files) ? (args.files as string[]) : [];
      const workDir = args._workDir as string | undefined;
      const fileRefs: FileRef[] = [];
      for (const filePath of rawFiles) {
        if (typeof filePath !== 'string' || !filePath) continue;
        try {
          const absPath = workDir ? resolve(workDir, filePath) : filePath;
          if (existsSync(absPath)) {
            const st = statSync(absPath);
            fileRefs.push({ path: filePath, size: st.size });
          } else {
            fileRefs.push({ path: filePath });
          }
        } catch {
          fileRefs.push({ path: filePath });
        }
      }

      // Create inbox conversation so the question persists as a thread
      if (deps.conversationsService) {
        try {
          const conv = deps.conversationsService.createConversation(
            botId,
            'inbox',
            truncateTitle(question),
            {
              askHumanQuestionId: id,
              inboxStatus: 'pending',
              askOptions: options,
            }
          );
          deps.conversationsService.addMessage(
            botId,
            conv.id,
            'bot',
            question,
            fileRefs.length > 0 ? fileRefs : undefined
          );
          deps.store.setConversationId(id, conv.id);
          logger.debug(
            { questionId: id, conversationId: conv.id, files: fileRefs.length },
            'ask_human: inbox conversation created'
          );
        } catch (err) {
          logger.warn(
            { err, questionId: id },
            'ask_human: failed to create inbox conversation (non-fatal)'
          );
        }
      }

      // Send Telegram notification if we have a valid chatId and bot instance
      const notifiedChatIds = new Set<number>();
      if (chatId) {
        const bot = deps.getBotInstance(botId);
        if (bot) {
          const botName = deps.getBotName(botId);
          const optionsLine = options ? `\n\nOptions: ${options.join(' | ')}` : '';
          const messageText = `🤖 **${botName} needs your input:**\n\n${question}${optionsLine}\n\n_Reply to this message to answer._`;
          notifiedChatIds.add(chatId);
          try {
            const sent = await bot.api.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
            deps.store.setMessageId(id, sent.message_id);
          } catch (telegramErr) {
            logger.warn(
              { botId, chatId, err: telegramErr },
              'ask_human: failed to send Telegram notification, question still queued in inbox'
            );
          }
        }
      }

      // config.operator.notifyOnAsk: also ping the operator, who otherwise has
      // to poll the dashboard inbox. Most agent-loop asks carry no chatId at
      // all, so this is the only notification they ever produce.
      await notifyOperatorOfAsk(deps, logger, {
        botId,
        question,
        options,
        questionId: id,
        alreadyNotified: notifiedChatIds,
      });

      logger.info(
        { questionId: id, botId, chatId: chatId || null, options: options?.length ?? 0 },
        'ask_human: question queued to inbox (non-blocking)'
      );

      const questionMarks = (question.match(/\?/g) ?? []).length;
      const tip =
        questionMarks > 1
          ? `Tip: single-question asks get answered; yours has ${questionMarks}. Next time ask one thing per ask_human call. `
          : '';

      return {
        success: true,
        content: [
          `${tip}Question has been queued to the human inbox.`,
          'The answer will be available in your next cycle.',
          'Continue with other tasks in the meantime.',
        ].join(' '),
      };
    },
  };
}

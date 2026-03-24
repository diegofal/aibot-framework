import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';

export interface PendingQuestion {
  id: string;
  botId: string;
  chatId: number;
  question: string;
  messageId: number | null;
  conversationId?: string;
  resolve: (answer: string) => void;
  reject: (reason: Error) => void;
  createdAt: number;
}

export interface PendingQuestionInfo {
  id: string;
  botId: string;
  chatId: number;
  question: string;
  conversationId?: string;
  createdAt: number;
}

export interface AnsweredQuestion {
  id: string;
  botId: string;
  question: string;
  answer: string;
  answeredAt: number;
  conversationId?: string;
}

export interface HandleReplyResult {
  matched: boolean;
  questionId?: string;
  conversationId?: string;
  botId?: string;
}

/**
 * Manages pending "ask_human" questions.
 * Sends a Telegram message, waits for a reply, and resolves the promise.
 */
export class AskHumanStore {
  private pending = new Map<string, PendingQuestion>();
  // botId:chatId → question id (for quick lookup when a reply comes in)
  private byChatId = new Map<string, Set<string>>();
  // Answered questions waiting to be consumed by the next agent loop cycle
  private answered = new Map<string, AnsweredQuestion>();

  private onTimeout?: (questionId: string, botId: string, conversationId?: string) => void;
  private onDismiss?: (questionId: string, botId: string, conversationId?: string) => void;

  constructor(
    private logger: Logger,
    private dataDir?: string,
    callbacks?: {
      onTimeout?: (questionId: string, botId: string, conversationId?: string) => void;
      onDismiss?: (questionId: string, botId: string, conversationId?: string) => void;
    }
  ) {
    this.onTimeout = callbacks?.onTimeout;
    this.onDismiss = callbacks?.onDismiss;
    if (dataDir) this.loadFromDisk();
  }

  /** Load answered questions from disk on startup. Pending entries are NOT persisted. */
  loadFromDisk(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'answered.json');
    if (!existsSync(filePath)) return;

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (raw.answered && typeof raw.answered === 'object') {
        for (const [id, entry] of Object.entries(raw.answered)) {
          this.answered.set(id, entry as AnsweredQuestion);
        }
      }
      this.logger.debug({ count: this.answered.size }, 'AskHuman: loaded from disk');
    } catch (err) {
      this.logger.warn({ err }, 'AskHuman: failed to load from disk');
    }
  }

  /** Persist answered map to disk. */
  private persistAnswered(): void {
    if (!this.dataDir) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const data = {
        answered: Object.fromEntries(this.answered),
      };
      writeFileSync(join(this.dataDir, 'answered.json'), JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn({ err }, 'AskHuman: failed to persist to disk');
    }
  }

  /**
   * Register a pending question. Returns a promise that resolves with the human's answer.
   * The caller is responsible for sending the Telegram message and calling setMessageId().
   */
  ask(botId: string, chatId: number, question: string): { id: string; promise: Promise<string> } {
    const id = randomUUID();

    const { promise, resolve, reject } = this.createDeferredPromise<string>();

    const entry: PendingQuestion = {
      id,
      botId,
      chatId,
      question,
      messageId: null,
      resolve,
      reject,
      createdAt: Date.now(),
    };

    this.pending.set(id, entry);
    const compositeKey = `${botId}:${chatId}`;
    if (!this.byChatId.has(compositeKey)) {
      this.byChatId.set(compositeKey, new Set());
    }
    this.byChatId.get(compositeKey)?.add(id);

    this.logger.debug({ id, botId, chatId }, 'AskHuman: question registered');

    return { id, promise };
  }

  /**
   * Set the Telegram message ID after sending the question.
   * Used for reply matching.
   */
  setMessageId(questionId: string, messageId: number): void {
    const entry = this.pending.get(questionId);
    if (entry) {
      entry.messageId = messageId;
    }
  }

  /**
   * Set the conversation ID after creating the inbox conversation.
   */
  setConversationId(questionId: string, conversationId: string): void {
    const entry = this.pending.get(questionId);
    if (entry) {
      entry.conversationId = conversationId;
    }
  }

  /**
   * Try to match an incoming reply to a pending question in this chat.
   * If replyToMessageId matches a pending question's messageId, resolve it.
   * If no replyToMessageId but there's exactly one pending question in the chat, resolve that.
   * Returns true if a question was matched and resolved.
   */
  handleReply(
    botId: string,
    chatId: number,
    text: string,
    replyToMessageId?: number
  ): HandleReplyResult {
    const questionIds = this.byChatId.get(`${botId}:${chatId}`);
    if (!questionIds || questionIds.size === 0) return { matched: false };

    // Try to match by reply-to
    if (replyToMessageId) {
      for (const qId of questionIds) {
        const entry = this.pending.get(qId);
        if (entry && entry.messageId === replyToMessageId) {
          this.logger.info({ questionId: qId, chatId }, 'AskHuman: reply matched by message ID');
          this.answered.set(qId, {
            id: qId,
            botId: entry.botId,
            question: entry.question,
            answer: text,
            answeredAt: Date.now(),
            conversationId: entry.conversationId,
          });
          this.persistAnswered();
          entry.resolve(text);
          const conversationId = entry.conversationId;
          const botId = entry.botId;
          this.cleanup(qId);
          return { matched: true, questionId: qId, conversationId, botId };
        }
      }
    }

    // Fallback: if exactly one pending question in this chat, match it
    if (questionIds.size === 1) {
      const qId = questionIds.values().next().value as string;
      const entry = this.pending.get(qId);
      if (entry) {
        this.logger.info({ questionId: qId, chatId }, 'AskHuman: reply matched (single pending)');
        this.answered.set(qId, {
          id: qId,
          botId: entry.botId,
          question: entry.question,
          answer: text,
          answeredAt: Date.now(),
          conversationId: entry.conversationId,
        });
        this.persistAnswered();
        entry.resolve(text);
        const conversationId = entry.conversationId;
        const botId = entry.botId;
        this.cleanup(qId);
        return { matched: true, questionId: qId, conversationId, botId };
      }
    }

    return { matched: false };
  }

  /**
   * Check if there are any pending questions for a chat.
   */
  hasPending(botId: string, chatId: number): boolean {
    const ids = this.byChatId.get(`${botId}:${chatId}`);
    return !!ids && ids.size > 0;
  }

  private cleanup(questionId: string): void {
    const entry = this.pending.get(questionId);
    if (!entry) return;

    this.pending.delete(questionId);

    const compositeKey = `${entry.botId}:${entry.chatId}`;
    const chatIds = this.byChatId.get(compositeKey);
    if (chatIds) {
      chatIds.delete(questionId);
      if (chatIds.size === 0) {
        this.byChatId.delete(compositeKey);
      }
    }
  }

  private createDeferredPromise<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: Error) => void;
  } {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  getAll(): PendingQuestionInfo[] {
    const result: PendingQuestionInfo[] = [];
    for (const entry of this.pending.values()) {
      result.push({
        id: entry.id,
        botId: entry.botId,
        chatId: entry.chatId,
        question: entry.question,
        conversationId: entry.conversationId,
        createdAt: entry.createdAt,
      });
    }
    return result;
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  answerById(id: string, answer: string): { ok: boolean; conversationId?: string; botId?: string } {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false };
    this.logger.info({ questionId: id }, 'AskHuman: answered via web');
    this.answered.set(id, {
      id,
      botId: entry.botId,
      question: entry.question,
      answer,
      answeredAt: Date.now(),
      conversationId: entry.conversationId,
    });
    this.persistAnswered();
    entry.resolve(answer);
    const conversationId = entry.conversationId;
    const botId = entry.botId;
    this.cleanup(id);
    return { ok: true, conversationId, botId };
  }

  dismissById(id: string): { ok: boolean; conversationId?: string; botId?: string } {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false };
    this.logger.info({ questionId: id }, 'AskHuman: dismissed via web');
    const conversationId = entry.conversationId;
    const botId = entry.botId;
    entry.reject(new Error('Question dismissed'));
    this.cleanup(id);
    this.onDismiss?.(id, botId, conversationId);
    return { ok: true, conversationId, botId };
  }

  hasPendingForBot(botId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.botId === botId) return true;
    }
    return false;
  }

  /** Returns and deletes all answered questions for a bot (consumed by next agent loop cycle). */
  consumeAnswersForBot(botId: string): AnsweredQuestion[] {
    const results: AnsweredQuestion[] = [];
    for (const [id, entry] of this.answered) {
      if (entry.botId === botId) {
        results.push(entry);
        this.answered.delete(id);
      }
    }
    if (results.length > 0) this.persistAnswered();
    return results;
  }

  /** Returns pending (unanswered) questions for a bot. */
  getPendingForBot(botId: string): PendingQuestionInfo[] {
    const results: PendingQuestionInfo[] = [];
    for (const entry of this.pending.values()) {
      if (entry.botId !== botId) continue;
      results.push({
        id: entry.id,
        botId: entry.botId,
        chatId: entry.chatId,
        question: entry.question,
        conversationId: entry.conversationId,
        createdAt: entry.createdAt,
      });
    }
    return results;
  }

  /** Clear all pending questions and answered entries for a specific bot. */
  clearForBot(botId: string): void {
    // Reject + remove pending questions for this bot
    for (const [id, entry] of this.pending) {
      if (entry.botId === botId) {
        entry.reject(new Error('AskHumanStore cleared for bot reset'));
        this.pending.delete(id);
        const compositeKey = `${entry.botId}:${entry.chatId}`;
        const chatIds = this.byChatId.get(compositeKey);
        if (chatIds) {
          chatIds.delete(id);
          if (chatIds.size === 0) this.byChatId.delete(compositeKey);
        }
      }
    }
    // Clear answered entries for this bot
    for (const [id, entry] of this.answered) {
      if (entry.botId === botId) this.answered.delete(id);
    }
    this.logger.info({ botId }, 'AskHuman: cleared all entries for bot');
    this.persistAnswered();
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      entry.reject(new Error('AskHumanStore disposed'));
    }
    this.pending.clear();
    this.byChatId.clear();
    this.answered.clear();
  }
}

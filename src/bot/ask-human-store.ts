import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger';

export interface PendingQuestion {
  id: string;
  botId: string;
  chatId: number;
  question: string;
  messageId: number | null;
  resolve: (answer: string) => void;
  reject: (reason: Error) => void;
  createdAt: number;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingQuestionInfo {
  id: string;
  botId: string;
  chatId: number;
  question: string;
  createdAt: number;
  timeoutMs: number;
  remainingMs: number;
}

export interface AnsweredQuestion {
  id: string;
  botId: string;
  question: string;
  answer: string;
  answeredAt: number;
}

/**
 * Manages pending "ask_human" questions.
 * Sends a Telegram message, waits for a reply, and resolves the promise.
 */
export class AskHumanStore {
  private pending = new Map<string, PendingQuestion>();
  // chatId → question id (for quick lookup when a reply comes in)
  private byChatId = new Map<number, Set<string>>();
  // Answered questions waiting to be consumed by the next agent loop cycle
  private answered = new Map<string, AnsweredQuestion>();

  constructor(private logger: Logger) {}

  /**
   * Register a pending question. Returns a promise that resolves with the human's answer.
   * The caller is responsible for sending the Telegram message and calling setMessageId().
   */
  ask(
    botId: string,
    chatId: number,
    question: string,
    timeoutMs: number,
  ): { id: string; promise: Promise<string> } {
    const id = randomUUID();

    const { promise, resolve, reject } = this.createDeferredPromise<string>();

    const timer = setTimeout(() => {
      this.cleanup(id);
      reject(new Error('Question timed out — no response received'));
    }, timeoutMs);

    const entry: PendingQuestion = {
      id,
      botId,
      chatId,
      question,
      messageId: null,
      resolve,
      reject,
      createdAt: Date.now(),
      timeoutMs,
      timer,
    };

    this.pending.set(id, entry);
    if (!this.byChatId.has(chatId)) {
      this.byChatId.set(chatId, new Set());
    }
    this.byChatId.get(chatId)!.add(id);

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
   * Try to match an incoming reply to a pending question in this chat.
   * If replyToMessageId matches a pending question's messageId, resolve it.
   * If no replyToMessageId but there's exactly one pending question in the chat, resolve that.
   * Returns true if a question was matched and resolved.
   */
  handleReply(chatId: number, text: string, replyToMessageId?: number): boolean {
    const questionIds = this.byChatId.get(chatId);
    if (!questionIds || questionIds.size === 0) return false;

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
          });
          entry.resolve(text);
          this.cleanup(qId);
          return true;
        }
      }
    }

    // Fallback: if exactly one pending question in this chat, match it
    if (questionIds.size === 1) {
      const qId = questionIds.values().next().value!;
      const entry = this.pending.get(qId);
      if (entry) {
        this.logger.info({ questionId: qId, chatId }, 'AskHuman: reply matched (single pending)');
        this.answered.set(qId, {
          id: qId,
          botId: entry.botId,
          question: entry.question,
          answer: text,
          answeredAt: Date.now(),
        });
        entry.resolve(text);
        this.cleanup(qId);
        return true;
      }
    }

    return false;
  }

  /**
   * Check if there are any pending questions for a chat.
   */
  hasPending(chatId: number): boolean {
    const ids = this.byChatId.get(chatId);
    return !!ids && ids.size > 0;
  }

  private cleanup(questionId: string): void {
    const entry = this.pending.get(questionId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(questionId);

    const chatIds = this.byChatId.get(entry.chatId);
    if (chatIds) {
      chatIds.delete(questionId);
      if (chatIds.size === 0) {
        this.byChatId.delete(entry.chatId);
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
    const now = Date.now();
    const result: PendingQuestionInfo[] = [];
    for (const entry of this.pending.values()) {
      const elapsed = now - entry.createdAt;
      const remainingMs = Math.max(0, entry.timeoutMs - elapsed);
      result.push({
        id: entry.id,
        botId: entry.botId,
        chatId: entry.chatId,
        question: entry.question,
        createdAt: entry.createdAt,
        timeoutMs: entry.timeoutMs,
        remainingMs,
      });
    }
    return result;
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  answerById(id: string, answer: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.logger.info({ questionId: id }, 'AskHuman: answered via web');
    this.answered.set(id, {
      id,
      botId: entry.botId,
      question: entry.question,
      answer,
      answeredAt: Date.now(),
    });
    entry.resolve(answer);
    this.cleanup(id);
    return true;
  }

  dismissById(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.logger.info({ questionId: id }, 'AskHuman: dismissed via web');
    entry.reject(new Error('Question dismissed'));
    this.cleanup(id);
    return true;
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
    return results;
  }

  /** Returns pending (unanswered) questions for a bot. */
  getPendingForBot(botId: string): PendingQuestionInfo[] {
    const now = Date.now();
    const results: PendingQuestionInfo[] = [];
    for (const entry of this.pending.values()) {
      if (entry.botId !== botId) continue;
      const elapsed = now - entry.createdAt;
      const remainingMs = Math.max(0, entry.timeoutMs - elapsed);
      results.push({
        id: entry.id,
        botId: entry.botId,
        chatId: entry.chatId,
        question: entry.question,
        createdAt: entry.createdAt,
        timeoutMs: entry.timeoutMs,
        remainingMs,
      });
    }
    return results;
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('AskHumanStore disposed'));
    }
    this.pending.clear();
    this.byChatId.clear();
    this.answered.clear();
  }
}

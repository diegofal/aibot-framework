import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';
import type { WorkerAnswer } from '../workers/types';

/**
 * Hands an answer, decision or dismissal to the worker run that asked
 * (`WorkerPoolApi.onAnswer`, plan C15). Returns false when no pool took it
 * (not wired, or it threw): the store then keeps an answer for the run to
 * pull, never for the cycle.
 */
export type RunAnswerRouter = (runId: string, answer: WorkerAnswer) => boolean;

const ASKED_ID_RE = /\(id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i;

/**
 * The question id an `ask_human` tool result announces (`… (id <uuid>) …`),
 * or null when the call registered no question (refused: already pending,
 * too long, …).
 */
export function askedQuestionId(result: string): string | null {
  return ASKED_ID_RE.exec(result)?.[1] ?? null;
}

export interface PendingQuestion {
  id: string;
  botId: string;
  chatId: number;
  question: string;
  messageId: number | null;
  conversationId?: string;
  /** Quick-reply choices offered to the operator (2-4 short strings). */
  options?: string[];
  resolve: (answer: string) => void;
  reject: (reason: Error) => void;
  createdAt: number;
  /** Agent-loop cycle the question was asked in (absent outside a cycle). */
  cycleId?: string;
  /** Goal that cycle served, when known. */
  goalId?: string;
  /** Worker run that asked (its answer goes to the run, not the cycle). */
  runId?: string;
  /** Task that run works on. */
  taskId?: string;
}

export interface PendingQuestionInfo {
  id: string;
  botId: string;
  chatId: number;
  question: string;
  conversationId?: string;
  options?: string[];
  createdAt: number;
  /** Agent-loop cycle the question was asked in (absent outside a cycle). */
  cycleId?: string;
  /** Goal that cycle served, when known. */
  goalId?: string;
  /** Worker run that asked (its answer goes to the run, not the cycle). */
  runId?: string;
  /** Task that run works on. */
  taskId?: string;
}

/** Attribution of a question: the cycle (and goal), or the worker run (and task). */
export interface AskAttribution {
  cycleId?: string;
  goalId?: string;
  runId?: string;
  taskId?: string;
}

export interface AnsweredQuestion {
  id: string;
  botId: string;
  question: string;
  answer: string;
  answeredAt: number;
  conversationId?: string;
  /** Set when a worker run asked and the pool did not take the answer: it waits for the run. */
  runId?: string;
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
 * Answered (`answered.json`) and pending (`pending.json`) questions are both
 * persisted under `dataDir`, so a restart loses neither.
 */
export class AskHumanStore {
  private pending = new Map<string, PendingQuestion>();
  // botId:chatId → question id (for quick lookup when a reply comes in)
  private byChatId = new Map<string, Set<string>>();
  // Answered questions waiting to be consumed by the next agent loop cycle
  private answered = new Map<string, AnsweredQuestion>();

  private onTimeout?: (questionId: string, botId: string, conversationId?: string) => void;
  private onDismiss?: (questionId: string, botId: string, conversationId?: string) => void;
  private onAnswer?: (answered: AnsweredQuestion) => void;
  private runRouter?: RunAnswerRouter;

  constructor(
    private logger: Logger,
    private dataDir?: string,
    callbacks?: {
      onTimeout?: (questionId: string, botId: string, conversationId?: string) => void;
      onDismiss?: (questionId: string, botId: string, conversationId?: string) => void;
      /**
       * Fires once per answer (web or Telegram), after it is queued for the
       * next agent-loop cycle. Errors are logged and swallowed.
       */
      onAnswer?: (answered: AnsweredQuestion) => void;
    }
  ) {
    this.onTimeout = callbacks?.onTimeout;
    this.onDismiss = callbacks?.onDismiss;
    this.onAnswer = callbacks?.onAnswer;
    if (dataDir) this.loadFromDisk();
  }

  /**
   * Load answered and pending questions from disk on startup.
   *
   * Pending questions are persisted too: they used to live only in memory, so
   * a restart orphaned every open inbox ask — the 72 h sweep could not see
   * them and an operator answer could no longer reach the planner.
   */
  loadFromDisk(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'answered.json');
    if (existsSync(filePath)) {
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

    const pendingPath = join(this.dataDir, 'pending.json');
    if (!existsSync(pendingPath)) return;
    try {
      const raw = JSON.parse(readFileSync(pendingPath, 'utf-8'));
      const entries: unknown[] = Array.isArray(raw?.pending) ? raw.pending : [];
      for (const item of entries) {
        const e = item as Partial<PendingQuestionInfo> & { messageId?: number | null };
        if (typeof e.id !== 'string' || typeof e.botId !== 'string') continue;
        if (typeof e.question !== 'string' || typeof e.createdAt !== 'number') continue;
        this.insertRestored(
          {
            id: e.id,
            botId: e.botId,
            chatId: typeof e.chatId === 'number' ? e.chatId : 0,
            question: e.question,
            ...(e.conversationId ? { conversationId: e.conversationId } : {}),
            ...(Array.isArray(e.options) && e.options.length > 0 ? { options: e.options } : {}),
            createdAt: e.createdAt,
            ...attributionOf(e),
          },
          typeof e.messageId === 'number' ? e.messageId : null
        );
      }
      this.logger.debug({ count: this.pending.size }, 'AskHuman: pending questions restored');
    } catch (err) {
      this.logger.warn({ err }, 'AskHuman: failed to load pending questions from disk');
    }
  }

  /** Persist the pending set (without promise callbacks) to disk. */
  private persistPending(): void {
    if (!this.dataDir) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const pending = [...this.pending.values()].map((e) => ({
        ...this.toInfo(e),
        messageId: e.messageId,
      }));
      writeFileSync(
        join(this.dataDir, 'pending.json'),
        JSON.stringify({ pending }, null, 2),
        'utf-8'
      );
    } catch (err) {
      this.logger.warn({ err }, 'AskHuman: failed to persist pending questions');
    }
  }

  /**
   * Insert a question recovered from disk or from the inbox. Nobody awaits
   * its promise any more, so the rejection on close/dismiss is swallowed.
   */
  private insertRestored(info: PendingQuestionInfo, messageId: number | null): boolean {
    if (this.pending.has(info.id)) return false;
    const { promise, resolve, reject } = this.createDeferredPromise<string>();
    promise.catch(() => {});
    this.pending.set(info.id, { ...info, messageId, resolve, reject });
    const compositeKey = `${info.botId}:${info.chatId}`;
    if (!this.byChatId.has(compositeKey)) this.byChatId.set(compositeKey, new Set());
    this.byChatId.get(compositeKey)?.add(info.id);
    return true;
  }

  /**
   * Re-register a pending question the store lost (an inbox conversation still
   * marked `pending` from before pending questions were persisted). Returns
   * false when the id is already pending.
   */
  restorePending(info: PendingQuestionInfo): boolean {
    const inserted = this.insertRestored(info, null);
    if (inserted) this.persistPending();
    return inserted;
  }

  /** Wire the worker pool (BotManager). Undefined unwires it. */
  setRunRouter(router: RunAnswerRouter | undefined): void {
    this.runRouter = router;
  }

  /** Hand an answer or dismissal to the run; false when no pool took it. */
  private routeToRun(runId: string, answer: WorkerAnswer): boolean {
    if (!this.runRouter) return false;
    try {
      return this.runRouter(runId, answer);
    } catch (err) {
      this.logger.warn({ err, runId, questionId: answer.id }, 'AskHuman: run routing failed');
      return false;
    }
  }

  /** A run's question closed without an answer: the run ends blocked. */
  private routeDismissed(entry: PendingQuestion): void {
    if (!entry.runId) return;
    if (!this.routeToRun(entry.runId, { kind: 'ask', id: entry.id, dismissed: true })) {
      this.logger.warn(
        { runId: entry.runId, questionId: entry.id },
        'AskHuman: dismissal of a run question not delivered (no worker pool)'
      );
    }
  }

  /**
   * The answer goes to its asker: a worker run gets it through the pool, the
   * cycle through the answered queue (`consumeAnswersForBot`). A run answer
   * the pool did not take is kept apart for `consumeAnswersForRun`, never for
   * the cycle. Resolves the waiter, fires onAnswer.
   */
  private recordAnswer(entry: PendingQuestion, answer: string): void {
    const answered: AnsweredQuestion = {
      id: entry.id,
      botId: entry.botId,
      question: entry.question,
      answer,
      answeredAt: Date.now(),
      conversationId: entry.conversationId,
    };
    const toRun =
      entry.runId !== undefined &&
      this.routeToRun(entry.runId, { kind: 'ask', id: entry.id, answer });
    if (!toRun) {
      this.answered.set(entry.id, entry.runId ? { ...answered, runId: entry.runId } : answered);
      this.persistAnswered();
    }
    entry.resolve(answer);
    try {
      this.onAnswer?.(answered);
    } catch (err) {
      this.logger.warn({ err, questionId: entry.id }, 'AskHuman: onAnswer callback failed');
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
  ask(
    botId: string,
    chatId: number,
    question: string,
    options?: string[],
    createdAt: number = Date.now(),
    attribution: AskAttribution = {}
  ): { id: string; promise: Promise<string> } {
    const id = randomUUID();

    const { promise, resolve, reject } = this.createDeferredPromise<string>();

    const entry: PendingQuestion = {
      id,
      botId,
      chatId,
      question,
      messageId: null,
      ...(options && options.length > 0 ? { options } : {}),
      resolve,
      reject,
      createdAt,
      ...attributionOf(attribution),
    };

    this.pending.set(id, entry);
    const compositeKey = `${botId}:${chatId}`;
    if (!this.byChatId.has(compositeKey)) {
      this.byChatId.set(compositeKey, new Set());
    }
    this.byChatId.get(compositeKey)?.add(id);
    this.persistPending();

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
      this.persistPending();
    }
  }

  /** Override createdAt (tests and restore paths); no-op for unknown ids. */
  setCreatedAt(questionId: string, createdAt: number): void {
    const entry = this.pending.get(questionId);
    if (entry) entry.createdAt = createdAt;
  }

  /**
   * Close every pending question older than `maxAgeMs`, optionally for one bot
   * only. The promise rejects with an auto-close reason so the original
   * ask_human caller logs it as such. Neither onDismiss nor onTimeout fires:
   * the sweep that calls this owns the inbox status and the memory note, and
   * a second callback would race it with a different status.
   */
  closeStale(maxAgeMs: number, now: number = Date.now(), botId?: string): PendingQuestionInfo[] {
    const hours = Math.round((maxAgeMs / 3_600_000) * 100) / 100;
    const closed: PendingQuestionInfo[] = [];
    for (const entry of [...this.pending.values()]) {
      if (botId && entry.botId !== botId) continue;
      if (now - entry.createdAt <= maxAgeMs) continue;
      closed.push(this.toInfo(entry));
      entry.reject(new Error(`Question auto-closed after ${hours}h without answer`));
      this.cleanup(entry.id);
      this.routeDismissed(entry);
    }
    if (closed.length > 0) {
      this.logger.info(
        { count: closed.length, maxAgeMs, botId: botId ?? null },
        'AskHuman: stale questions auto-closed'
      );
    }
    return closed;
  }

  private toInfo(entry: PendingQuestion): PendingQuestionInfo {
    return {
      id: entry.id,
      botId: entry.botId,
      chatId: entry.chatId,
      question: entry.question,
      conversationId: entry.conversationId,
      ...(entry.options ? { options: entry.options } : {}),
      createdAt: entry.createdAt,
      ...attributionOf(entry),
    };
  }

  /**
   * Set the conversation ID after creating the inbox conversation.
   */
  setConversationId(questionId: string, conversationId: string): void {
    const entry = this.pending.get(questionId);
    if (entry) {
      entry.conversationId = conversationId;
      this.persistPending();
    }
  }

  /**
   * Try to match an incoming reply to a pending question in this chat.
   * If replyToMessageId matches a pending question's messageId, resolve it.
   * If no replyToMessageId but there's exactly one pending question in the chat
   * AND its notification was sent to that chat (`messageId` set), resolve that.
   * A question asked from someone else's conversation never wrote into the chat,
   * so it must not capture that person's next message.
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
          this.recordAnswer(entry, text);
          const conversationId = entry.conversationId;
          const botId = entry.botId;
          this.cleanup(qId);
          return { matched: true, questionId: qId, conversationId, botId };
        }
      }
    }

    // Fallback: exactly one pending question for the whole bot (cycle and every
    // worker run), it is in this chat, and it was notified here. With several
    // pending a plain message cannot say which one it answers: only a reply-to
    // matches. Entries restored from an older pending.json follow the same rule:
    // a messageId means the notification landed in this chat, so they keep the
    // old behaviour; without one they never capture plain messages.
    if (questionIds.size === 1 && this.pendingCountForBot(botId) === 1) {
      const qId = questionIds.values().next().value as string;
      const entry = this.pending.get(qId);
      if (entry && entry.messageId !== null) {
        this.logger.info({ questionId: qId, chatId }, 'AskHuman: reply matched (single pending)');
        this.recordAnswer(entry, text);
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
  private pendingCountForBot(botId: string): number {
    let n = 0;
    for (const entry of this.pending.values()) if (entry.botId === botId) n++;
    return n;
  }

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
    this.persistPending();
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
      result.push(this.toInfo(entry));
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
    this.recordAnswer(entry, answer);
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
    this.routeDismissed(entry);
    this.onDismiss?.(id, botId, conversationId);
    return { ok: true, conversationId, botId };
  }

  hasPendingForBot(botId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.botId === botId) return true;
    }
    return false;
  }

  /**
   * Returns and deletes the cycle's answered questions for a bot (consumed by
   * the next agent loop cycle). Answers kept for a worker run are not the
   * cycle's: see `consumeAnswersForRun`.
   */
  consumeAnswersForBot(botId: string): AnsweredQuestion[] {
    const results: AnsweredQuestion[] = [];
    for (const [id, entry] of this.answered) {
      if (entry.botId === botId && !entry.runId) {
        results.push(entry);
        this.answered.delete(id);
      }
    }
    if (results.length > 0) this.persistAnswered();
    return results;
  }

  /** Answers for a worker run that the pool could not take when they arrived. */
  consumeAnswersForRun(runId: string): AnsweredQuestion[] {
    const results: AnsweredQuestion[] = [];
    for (const [id, entry] of this.answered) {
      if (entry.runId === runId) {
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
      results.push(this.toInfo(entry));
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
        this.routeDismissed(entry);
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
    this.persistPending();
  }

  /** Shutdown: rejects in-memory waiters but leaves pending.json on disk for the next boot. */
  dispose(): void {
    for (const entry of this.pending.values()) {
      entry.reject(new Error('AskHumanStore disposed'));
    }
    this.pending.clear();
    this.byChatId.clear();
    this.answered.clear();
  }
}

/** Only the ids that were recorded: a question outside a cycle or run carries none. */
function attributionOf(a: AskAttribution): AskAttribution {
  const out: AskAttribution = {};
  if (typeof a.cycleId === 'string' && a.cycleId) out.cycleId = a.cycleId;
  if (typeof a.goalId === 'string' && a.goalId) out.goalId = a.goalId;
  if (typeof a.runId === 'string' && a.runId) out.runId = a.runId;
  if (typeof a.taskId === 'string' && a.taskId) out.taskId = a.taskId;
  return out;
}

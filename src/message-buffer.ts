import type { Context } from 'grammy';
import type { BotConfig } from './config';
import type { BufferConfig } from './config';
import type { Logger } from './logger';

export interface BufferEntry {
  sessionKey: string;
  ctx: Context;
  config: BotConfig;
  userText: string;
  images?: string[];
  sessionText?: string;
  messageId: number;
  isMedia: boolean;
  timestamp: number;
}

export type ConversationProcessor = (
  ctx: Context,
  config: BotConfig,
  sessionKey: string,
  userText: string,
  images?: string[],
  sessionText?: string,
) => Promise<void>;

const SEEN_MESSAGES_CAP = 250;

export class MessageBuffer {
  // Capa 1: inbound debounce buffers
  private inbound = new Map<string, { entries: BufferEntry[]; timer: ReturnType<typeof setTimeout> }>();
  // Capa 2: followup queues
  private queues = new Map<string, { entries: BufferEntry[]; timer: ReturnType<typeof setTimeout> | null }>();
  // Active Ollama tasks per session
  private activeTasks = new Map<string, Promise<void>>();
  // Message dedup
  private seenMessages = new Set<number>();

  constructor(
    private bufferConfig: BufferConfig,
    private processor: ConversationProcessor,
    private logger: Logger,
  ) {}

  /**
   * Single entry point — fire-and-forget (synchronous).
   * Routes to Capa 1 (debounce), Capa 2 (queue), or immediate dispatch.
   */
  enqueue(entry: BufferEntry): void {
    // Dedup by messageId
    if (this.seenMessages.has(entry.messageId)) {
      this.logger.debug({ messageId: entry.messageId }, 'Duplicate message ignored');
      return;
    }
    this.addSeen(entry.messageId);

    const { sessionKey } = entry;

    // Capa 2: if bot is busy with this session, enqueue as followup
    if (this.activeTasks.has(sessionKey)) {
      this.enqueueFollowup(entry);
      return;
    }

    // Media or debounce disabled → dispatch immediately (bypass Capa 1)
    if (entry.isMedia || this.bufferConfig.inboundDebounceMs <= 0) {
      this.dispatch(entry);
      return;
    }

    // Capa 1: buffer with debounce timer
    this.bufferInbound(entry);
  }

  /**
   * Clean up all timers — call on bot shutdown.
   */
  dispose(): void {
    for (const { timer } of this.inbound.values()) {
      clearTimeout(timer);
    }
    this.inbound.clear();

    for (const { timer } of this.queues.values()) {
      if (timer) clearTimeout(timer);
    }
    this.queues.clear();

    this.activeTasks.clear();
    this.seenMessages.clear();
  }

  // ─── Capa 1: Inbound Debounce ──────────────────────────────────

  private bufferInbound(entry: BufferEntry): void {
    const { sessionKey } = entry;
    const existing = this.inbound.get(sessionKey);

    if (existing) {
      clearTimeout(existing.timer);
      existing.entries.push(entry);
    } else {
      this.inbound.set(sessionKey, { entries: [entry], timer: null as unknown as ReturnType<typeof setTimeout> });
    }

    const buf = this.inbound.get(sessionKey)!;
    buf.timer = setTimeout(() => {
      this.flushInbound(sessionKey);
    }, this.bufferConfig.inboundDebounceMs);
  }

  private flushInbound(sessionKey: string): void {
    const buf = this.inbound.get(sessionKey);
    if (!buf || buf.entries.length === 0) return;
    this.inbound.delete(sessionKey);

    const merged = this.mergeEntries(buf.entries);
    this.dispatch(merged);
  }

  // ─── Capa 2: Followup Queue ────────────────────────────────────

  private enqueueFollowup(entry: BufferEntry): void {
    const { sessionKey } = entry;
    let queue = this.queues.get(sessionKey);

    if (!queue) {
      queue = { entries: [], timer: null };
      this.queues.set(sessionKey, queue);
    }

    // Cap check — drop oldest if over limit
    if (queue.entries.length >= this.bufferConfig.queueCap) {
      const dropped = queue.entries.shift()!;
      this.logger.warn(
        { sessionKey, droppedMessageId: dropped.messageId, queueCap: this.bufferConfig.queueCap },
        'Queue cap reached, dropping oldest message',
      );
    }

    queue.entries.push(entry);
    this.logger.debug(
      { sessionKey, queueSize: queue.entries.length, messageId: entry.messageId },
      'Message enqueued (bot busy)',
    );
  }

  private tryDrainQueue(sessionKey: string): void {
    const queue = this.queues.get(sessionKey);
    if (!queue || queue.entries.length === 0) {
      this.queues.delete(sessionKey);
      return;
    }

    // Apply queue debounce — wait a bit in case more messages arrive
    if (queue.timer) clearTimeout(queue.timer);

    if (this.bufferConfig.queueDebounceMs <= 0) {
      this.drainQueue(sessionKey);
      return;
    }

    queue.timer = setTimeout(() => {
      this.drainQueue(sessionKey);
    }, this.bufferConfig.queueDebounceMs);
  }

  private drainQueue(sessionKey: string): void {
    const queue = this.queues.get(sessionKey);
    if (!queue || queue.entries.length === 0) {
      this.queues.delete(sessionKey);
      return;
    }

    const entries = queue.entries.splice(0);
    queue.timer = null;
    this.queues.delete(sessionKey);

    const merged = this.mergeFollowupEntries(entries);
    this.dispatch(merged);
  }

  // ─── Dispatch ──────────────────────────────────────────────────

  private dispatch(entry: BufferEntry): void {
    const { ctx, config, sessionKey, userText, images, sessionText } = entry;

    const task = this.processor(ctx, config, sessionKey, userText, images, sessionText)
      .catch((err) => {
        this.logger.error({ err, sessionKey }, 'Conversation processor failed (buffer dispatch)');
      })
      .finally(() => {
        this.activeTasks.delete(sessionKey);
        this.tryDrainQueue(sessionKey);
      });

    this.activeTasks.set(sessionKey, task);
  }

  // ─── Merge helpers ─────────────────────────────────────────────

  /**
   * Capa 1 merge: concatenate texts with newline, combine images.
   * Uses the ctx from the last (most recent) entry.
   */
  private mergeEntries(entries: BufferEntry[]): BufferEntry {
    if (entries.length === 1) return entries[0];

    const last = entries[entries.length - 1];
    const texts = entries.map((e) => e.userText).filter(Boolean);
    const allImages = entries.flatMap((e) => e.images ?? []);
    const sessionTexts = entries.map((e) => e.sessionText ?? e.userText).filter(Boolean);

    this.logger.info(
      { sessionKey: last.sessionKey, count: entries.length },
      'Inbound debounce: merging messages',
    );

    return {
      ...last,
      userText: texts.join('\n'),
      images: allImages.length > 0 ? allImages : undefined,
      sessionText: sessionTexts.join('\n'),
    };
  }

  /**
   * Capa 2 merge: if 1 entry, return as-is.
   * If multiple, format with numbered separators for LLM context.
   */
  private mergeFollowupEntries(entries: BufferEntry[]): BufferEntry {
    if (entries.length === 1) return entries[0];

    const last = entries[entries.length - 1];
    const parts = entries.map((e, i) => `---\n#${i + 1}\n${e.userText}`);
    const merged = `[Mensajes adicionales enviados mientras respondías]\n\n${parts.join('\n\n')}`;

    const sessionTexts = entries.map((e, i) => `---\n#${i + 1}\n${e.sessionText ?? e.userText}`);
    const mergedSession = `[Followup messages]\n\n${sessionTexts.join('\n\n')}`;

    const allImages = entries.flatMap((e) => e.images ?? []);

    this.logger.info(
      { sessionKey: last.sessionKey, count: entries.length },
      'Followup queue: merging queued messages',
    );

    return {
      ...last,
      userText: merged,
      images: allImages.length > 0 ? allImages : undefined,
      sessionText: mergedSession,
    };
  }

  // ─── Dedup housekeeping ────────────────────────────────────────

  private addSeen(messageId: number): void {
    this.seenMessages.add(messageId);
    if (this.seenMessages.size > SEEN_MESSAGES_CAP) {
      // Prune oldest entries (Set preserves insertion order)
      const excess = this.seenMessages.size - SEEN_MESSAGES_CAP;
      let removed = 0;
      for (const id of this.seenMessages) {
        if (removed >= excess) break;
        this.seenMessages.delete(id);
        removed++;
      }
    }
  }
}

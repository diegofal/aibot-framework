import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Context } from 'grammy';
import type { SessionConfig } from './config';
import type { ChatMessage } from './ollama';
import type { SessionInfo } from './core/types';
import type { Logger } from './logger';

interface SessionMeta {
  key: string;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  compactionCount: number;
  lastFlushCompactionIndex?: number;
}

interface SessionKey {
  botId: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  chatId: number;
  userId?: number;
  threadId?: number;
}

export class SessionManager {
  private metadata: Map<string, SessionMeta> = new Map();
  private metadataPath: string;
  private transcriptsDir: string;
  private dirty = false;
  /** In-memory map of active group conversations: "chatId:userId" → timestamp ms */
  private activeConversations: Map<string, number> = new Map();
  private activeConvPath: string;
  private activeConvDirty = false;
  private activeConvTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private config: SessionConfig,
    private logger: Logger
  ) {
    this.metadataPath = join(config.dataDir, 'sessions.json');
    this.transcriptsDir = join(config.dataDir, 'transcripts');
    this.activeConvPath = join(config.dataDir, 'active-conversations.json');
  }

  /**
   * Create directories and load metadata index from disk
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('Session management disabled');
      return;
    }

    mkdirSync(this.transcriptsDir, { recursive: true });

    if (existsSync(this.metadataPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.metadataPath, 'utf-8'));
        for (const [key, meta] of Object.entries(raw)) {
          this.metadata.set(key, meta as SessionMeta);
        }
        this.logger.info({ sessions: this.metadata.size }, 'Session metadata loaded');
      } catch (err) {
        this.logger.warn({ err }, 'Failed to load sessions.json, starting fresh');
      }
    } else {
      this.flush();
      this.logger.info('Created empty sessions.json');
    }

    // Load persisted active conversations
    if (existsSync(this.activeConvPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.activeConvPath, 'utf-8')) as Record<string, number>;
        const now = Date.now();
        for (const [key, ts] of Object.entries(raw)) {
          if (this.config.replyWindow > 0) {
            // Timed mode: skip expired entries
            if (now - ts <= this.config.replyWindow * 60_000) {
              this.activeConversations.set(key, ts);
            }
          } else {
            // Unlimited mode (replyWindow === 0): load all
            this.activeConversations.set(key, ts);
          }
        }
        this.logger.info({ count: this.activeConversations.size }, 'Loaded active conversations');
      } catch (err) {
        this.logger.warn({ err }, 'Failed to load active-conversations.json, starting fresh');
      }
    }
  }

  /**
   * Derive a session key from a Grammy context
   */
  deriveKey(botId: string, ctx: Context): SessionKey {
    const chat = ctx.chat;
    if (!chat) {
      throw new Error('Cannot derive session key: no chat in context');
    }

    const chatType = chat.type as SessionKey['chatType'];

    if (chatType === 'private') {
      return {
        botId,
        chatType,
        chatId: chat.id,
        userId: ctx.from?.id,
      };
    }

    // Group / supergroup / channel
    const key: SessionKey = {
      botId,
      chatType,
      chatId: chat.id,
    };

    // Forum topic isolation
    if (this.config.forumTopicIsolation && ctx.message?.message_thread_id) {
      key.threadId = ctx.message.message_thread_id;
    }

    return key;
  }

  /**
   * Serialize a session key to a colon-delimited string
   */
  serializeKey(key: SessionKey): string {
    const parts = [`bot:${key.botId}`, `${key.chatType}:${key.chatId}`];
    if (key.chatType === 'private' && key.userId) {
      // For private chats, use userId as the identifier
      parts[1] = `private:${key.userId}`;
    }
    if (key.threadId !== undefined) {
      parts.push(`topic:${key.threadId}`);
    }
    return parts.join(':');
  }

  /**
   * Build a SessionInfo object for SkillContext
   */
  buildSessionInfo(key: SessionKey): SessionInfo {
    return {
      key: this.serializeKey(key),
      chatType: key.chatType,
      chatId: key.chatId,
      userId: key.userId,
      threadId: key.threadId,
    };
  }

  /**
   * Get the transcript file path for a serialized key
   */
  private transcriptPath(serializedKey: string): string {
    // Replace colons with dashes for filesystem safety
    const filename = serializedKey.replace(/:/g, '-') + '.jsonl';
    return join(this.transcriptsDir, filename);
  }

  /**
   * Check if a session has expired according to reset policies.
   * The caller is responsible for flushing to memory and clearing.
   */
  isExpired(serializedKey: string): boolean {
    const meta = this.metadata.get(serializedKey);
    if (!meta) return false;
    return this.shouldReset(meta);
  }

  /**
   * Read the full JSONL transcript without reset checks or maxHistory trimming.
   * Used to grab the conversation before clearing for memory flush.
   */
  getFullHistory(serializedKey: string): ChatMessage[] {
    const filePath = this.transcriptPath(serializedKey);
    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const content = readFileSync(filePath, 'utf-8').trim();
      if (!content) return [];

      const lines = content.split('\n');
      const messages: ChatMessage[] = [];
      for (const line of lines) {
        if (line.trim()) {
          messages.push(JSON.parse(line));
        }
      }
      return messages;
    } catch (err) {
      this.logger.warn({ err, key: serializedKey }, 'Failed to read transcript');
      return [];
    }
  }

  /**
   * Load history from JSONL, return last N messages.
   * Does NOT auto-clear expired sessions — caller must check isExpired() first.
   */
  getHistory(serializedKey: string, maxHistory: number): ChatMessage[] {
    const filePath = this.transcriptPath(serializedKey);
    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const content = readFileSync(filePath, 'utf-8').trim();
      if (!content) return [];

      const lines = content.split('\n');
      const messages: ChatMessage[] = [];
      for (const line of lines) {
        if (line.trim()) {
          messages.push(JSON.parse(line));
        }
      }

      // Return only the last maxHistory messages
      return messages.slice(-maxHistory);
    } catch (err) {
      this.logger.warn({ err, key: serializedKey }, 'Failed to read transcript');
      return [];
    }
  }

  /**
   * Append messages to the JSONL transcript and update metadata
   */
  appendMessages(serializedKey: string, messages: ChatMessage[], maxHistory: number): void {
    const filePath = this.transcriptPath(serializedKey);

    // Ensure parent dir exists (should already from initialize, but be safe)
    mkdirSync(dirname(filePath), { recursive: true });

    const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    appendFileSync(filePath, lines, 'utf-8');

    // Update metadata
    const now = new Date().toISOString();
    const existing = this.metadata.get(serializedKey);
    const meta: SessionMeta = {
      key: serializedKey,
      createdAt: existing?.createdAt ?? now,
      lastActivityAt: now,
      messageCount: (existing?.messageCount ?? 0) + messages.length,
      compactionCount: existing?.compactionCount ?? 0,
      lastFlushCompactionIndex: existing?.lastFlushCompactionIndex,
    };
    this.metadata.set(serializedKey, meta);
    this.dirty = true;

    // Compact if file has grown too large
    this.maybeCompact(serializedKey, maxHistory);
  }

  /**
   * Clear a session: delete transcript file and remove metadata
   */
  clearSession(serializedKey: string): void {
    const filePath = this.transcriptPath(serializedKey);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    this.metadata.delete(serializedKey);
    this.dirty = true;
  }

  /**
   * Check if a session should be reset based on configured policies
   */
  private shouldReset(meta: SessionMeta): boolean {
    const lastActivity = new Date(meta.lastActivityAt);
    const now = new Date();

    // Daily reset
    const daily = this.config.resetPolicy.daily;
    if (daily.enabled) {
      const resetToday = new Date(now);
      resetToday.setHours(daily.hour, 0, 0, 0);

      // If last activity was before today's reset hour, reset
      if (lastActivity < resetToday && now >= resetToday) {
        return true;
      }

      // If last activity was yesterday or earlier (even if before reset hour)
      const lastActivityDay = new Date(lastActivity);
      lastActivityDay.setHours(0, 0, 0, 0);
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      if (lastActivityDay < todayStart && now >= resetToday) {
        return true;
      }
    }

    // Idle reset
    const idle = this.config.resetPolicy.idle;
    if (idle.enabled) {
      const idleMs = idle.minutes * 60_000;
      if (now.getTime() - lastActivity.getTime() > idleMs) {
        return true;
      }
    }

    return false;
  }

  /**
   * Mark a user's conversation as active in a group (for reply window)
   */
  markActive(chatId: number, userId: number): void {
    this.activeConversations.set(`${chatId}:${userId}`, Date.now());
    this.activeConvDirty = true;
    this.scheduleActiveConvFlush();
  }

  /**
   * Schedule a debounced flush of active conversations to disk (2s)
   */
  private scheduleActiveConvFlush(): void {
    if (this.activeConvTimer) return;
    this.activeConvTimer = setTimeout(() => {
      this.activeConvTimer = null;
      this.flushActiveConversations();
    }, 2000);
  }

  /**
   * Write active conversations to disk if dirty
   */
  private flushActiveConversations(): void {
    if (!this.activeConvDirty) return;
    try {
      const obj: Record<string, number> = {};
      for (const [key, ts] of this.activeConversations) {
        obj[key] = ts;
      }
      mkdirSync(dirname(this.activeConvPath), { recursive: true });
      writeFileSync(this.activeConvPath, JSON.stringify(obj, null, 2), 'utf-8');
      this.activeConvDirty = false;
      this.logger.debug({ count: this.activeConversations.size }, 'Active conversations flushed');
    } catch (err) {
      this.logger.error({ err }, 'Failed to flush active conversations');
    }
  }

  /**
   * Check if a user has an active conversation in a group (within reply window)
   */
  private isActive(chatId: number, userId?: number): boolean {
    if (!userId) return false;
    const key = `${chatId}:${userId}`;
    const ts = this.activeConversations.get(key);
    if (!ts) return false;
    // replyWindow === 0 means unlimited (never expires)
    if (this.config.replyWindow > 0 && Date.now() - ts > this.config.replyWindow * 60_000) {
      this.activeConversations.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Check if the bot should respond to a message in a group
   */
  shouldRespondInGroup(
    ctx: Context,
    botUsername?: string,
    botId?: string,
    mentionPatterns?: string[],
  ): boolean {
    if (this.config.groupActivation === 'always') {
      return true;
    }

    // Mention mode: check for @botusername mention, reply-to-bot, or active window
    const message = ctx.message;
    if (!message) return false;

    // Check if the message is a reply to one of the bot's messages
    if (message.reply_to_message?.from?.is_bot) {
      const replyBotId = message.reply_to_message.from.id;
      if (ctx.me?.id && replyBotId === ctx.me.id) {
        return true;
      }
    }

    // Check message entities for @botusername mention
    // Works for both text messages (entities/text) and media (caption_entities/caption)
    const entities = message.entities ?? message.caption_entities;
    const text = message.text ?? message.caption;

    if (botUsername && entities && text) {
      for (const entity of entities) {
        if (entity.type === 'mention') {
          const mentionText = text.substring(entity.offset, entity.offset + entity.length);
          if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
            return true;
          }
        }
      }
    }

    // Check for name-based mention patterns (case-insensitive, whole-word)
    if (mentionPatterns?.length && text) {
      for (const pattern of mentionPatterns) {
        const regex = new RegExp(`\\b${this.escapeRegex(pattern)}\\b`, 'i');
        if (regex.test(text)) {
          return true;
        }
      }
    }

    // Check active reply window for this user
    if (this.isActive(ctx.chat!.id, ctx.from?.id)) {
      return true;
    }

    return false;
  }

  /**
   * Strip @botusername from message text for cleaner prompts
   */
  stripBotMention(text: string, botUsername?: string, mentionPatterns?: string[]): string {
    if (!botUsername && !mentionPatterns?.length) return text;
    let result = text;
    if (botUsername) {
      result = result.replace(new RegExp(`@${this.escapeRegex(botUsername)}`, 'gi'), '');
    }
    if (mentionPatterns) {
      for (const pattern of mentionPatterns) {
        result = result.replace(new RegExp(`\\b${this.escapeRegex(pattern)}\\b`, 'gi'), '');
      }
    }
    return result.replace(/\s+/g, ' ').trim();
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Rewrite transcript file if it exceeds 2x maxHistory lines
   */
  private maybeCompact(serializedKey: string, maxHistory: number): void {
    const filePath = this.transcriptPath(serializedKey);
    if (!existsSync(filePath)) return;

    try {
      const content = readFileSync(filePath, 'utf-8').trim();
      if (!content) return;

      const lines = content.split('\n').filter((l) => l.trim());
      if (lines.length > maxHistory * 2) {
        const kept = lines.slice(-maxHistory);
        writeFileSync(filePath, kept.join('\n') + '\n', 'utf-8');

        // Update metadata message count and compaction counter
        const meta = this.metadata.get(serializedKey);
        if (meta) {
          meta.messageCount = kept.length;
          meta.compactionCount = (meta.compactionCount ?? 0) + 1;
          this.dirty = true;
        }

        this.logger.debug(
          { key: serializedKey, before: lines.length, after: kept.length },
          'Transcript compacted'
        );
      }
    } catch (err) {
      this.logger.warn({ err, key: serializedKey }, 'Failed to compact transcript');
    }
  }

  /**
   * Get session metadata for a serialized key (or undefined if not found)
   */
  getSessionMeta(serializedKey: string): SessionMeta | undefined {
    return this.metadata.get(serializedKey);
  }

  /**
   * Mark that a memory flush has been performed for this session,
   * recording the current compactionCount so we don't flush again
   * until the next compaction.
   */
  markMemoryFlushed(serializedKey: string): void {
    const meta = this.metadata.get(serializedKey);
    if (meta) {
      meta.lastFlushCompactionIndex = meta.compactionCount;
      this.dirty = true;
    }
  }

  /**
   * Write metadata index to disk
   */
  flush(): void {
    try {
      mkdirSync(dirname(this.metadataPath), { recursive: true });
      const obj: Record<string, SessionMeta> = {};
      for (const [key, meta] of this.metadata) {
        obj[key] = meta;
      }
      writeFileSync(this.metadataPath, JSON.stringify(obj, null, 2), 'utf-8');
      this.dirty = false;
      this.logger.debug({ sessions: this.metadata.size }, 'Session metadata flushed');
    } catch (err) {
      this.logger.error({ err }, 'Failed to flush session metadata');
    }
  }

  /**
   * Clean up timers and flush all pending data to disk
   */
  dispose(): void {
    if (this.activeConvTimer) {
      clearTimeout(this.activeConvTimer);
      this.activeConvTimer = null;
    }
    this.flushActiveConversations();
    this.flush();
  }
}

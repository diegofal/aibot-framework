import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ThreadMessage, FileRef } from '../types/thread';

export type ConversationType = 'general' | 'productions' | 'inbox';
export type InboxStatus = 'pending' | 'answered' | 'dismissed' | 'timed_out';

export interface Conversation {
  id: string;
  botId: string;
  type: ConversationType;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  askHumanQuestionId?: string;
  inboxStatus?: InboxStatus;
}

export class ConversationsService {
  constructor(private baseDir: string) {}

  private botDir(botId: string): string {
    return join(this.baseDir, botId);
  }

  private ensureBotDir(botId: string): string {
    const dir = this.botDir(botId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const messagesDir = join(dir, 'messages');
    if (!existsSync(messagesDir)) mkdirSync(messagesDir, { recursive: true });
    return dir;
  }

  private conversationsPath(botId: string): string {
    return join(this.botDir(botId), 'conversations.jsonl');
  }

  private messagesPath(botId: string, conversationId: string): string {
    return join(this.botDir(botId), 'messages', `${conversationId}.jsonl`);
  }

  private safeParseJsonlLines<T>(lines: string[], context: string): T[] {
    const results: T[] = [];
    for (const line of lines) {
      try { results.push(JSON.parse(line) as T); }
      catch { console.warn(`[ConversationsService] Skipping corrupt JSONL line in ${context}:`, line.slice(0, 100)); }
    }
    return results;
  }

  private readConversations(botId: string): Conversation[] {
    const path = this.conversationsPath(botId);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
    return this.safeParseJsonlLines<Conversation>(lines, 'conversations');
  }

  private writeConversations(botId: string, conversations: Conversation[]): void {
    this.ensureBotDir(botId);
    const path = this.conversationsPath(botId);
    const tmp = path + '.tmp';
    writeFileSync(tmp, conversations.map((c) => JSON.stringify(c)).join('\n') + (conversations.length ? '\n' : ''), 'utf-8');
    renameSync(tmp, path);
  }

  getBotIds(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  listConversations(botId: string, opts?: { type?: string; limit?: number; offset?: number }): Conversation[] {
    let convos = this.readConversations(botId);

    if (opts?.type) {
      convos = convos.filter((c) => c.type === opts.type);
    }

    // Sort by updatedAt desc
    convos.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return convos.slice(offset, offset + limit);
  }

  getConversation(botId: string, conversationId: string): Conversation | null {
    const convos = this.readConversations(botId);
    return convos.find((c) => c.id === conversationId) ?? null;
  }

  createConversation(
    botId: string,
    type: ConversationType = 'general',
    title?: string,
    meta?: { askHumanQuestionId?: string; inboxStatus?: InboxStatus },
  ): Conversation {
    this.ensureBotDir(botId);
    const now = new Date().toISOString();
    const defaultTitle = type === 'productions' ? 'Productions Chat' : type === 'inbox' ? 'Inbox Question' : 'New Conversation';
    const convo: Conversation = {
      id: randomUUID(),
      botId,
      type,
      title: title ?? defaultTitle,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      ...(meta?.askHumanQuestionId ? { askHumanQuestionId: meta.askHumanQuestionId } : {}),
      ...(meta?.inboxStatus ? { inboxStatus: meta.inboxStatus } : {}),
    };
    appendFileSync(this.conversationsPath(botId), JSON.stringify(convo) + '\n', 'utf-8');
    return convo;
  }

  updateTitle(botId: string, conversationId: string, title: string): Conversation | null {
    const convos = this.readConversations(botId);
    const idx = convos.findIndex((c) => c.id === conversationId);
    if (idx === -1) return null;
    convos[idx].title = title;
    convos[idx].updatedAt = new Date().toISOString();
    this.writeConversations(botId, convos);
    return convos[idx];
  }

  deleteConversation(botId: string, conversationId: string): boolean {
    const convos = this.readConversations(botId);
    const idx = convos.findIndex((c) => c.id === conversationId);
    if (idx === -1) return false;
    convos.splice(idx, 1);
    this.writeConversations(botId, convos);
    // Remove messages file
    const msgPath = this.messagesPath(botId, conversationId);
    if (existsSync(msgPath)) unlinkSync(msgPath);
    return true;
  }

  getMessages(botId: string, conversationId: string, opts?: { limit?: number }): ThreadMessage[] {
    const path = this.messagesPath(botId, conversationId);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
    let messages: ThreadMessage[] = this.safeParseJsonlLines<ThreadMessage>(lines, 'messages');
    if (opts?.limit) {
      messages = messages.slice(-opts.limit);
    }
    return messages;
  }

  addMessage(botId: string, conversationId: string, role: 'human' | 'bot', content: string, files?: FileRef[]): ThreadMessage | null {
    const convos = this.readConversations(botId);
    const idx = convos.findIndex((c) => c.id === conversationId);
    if (idx === -1) return null;

    this.ensureBotDir(botId);

    const message: ThreadMessage = {
      id: randomUUID(),
      role,
      content,
      ...(files && files.length > 0 ? { files } : {}),
      createdAt: new Date().toISOString(),
    };

    const msgPath = this.messagesPath(botId, conversationId);
    appendFileSync(msgPath, JSON.stringify(message) + '\n', 'utf-8');

    // Update conversation metadata
    convos[idx].messageCount += 1;
    convos[idx].updatedAt = message.createdAt;

    // Auto-title: if this is the first human message and title is default
    if (role === 'human' && convos[idx].messageCount === 1) {
      const defaultTitles = ['New Conversation', 'Productions Chat', 'Inbox Question'];
      if (defaultTitles.includes(convos[idx].title)) {
        convos[idx].title = this.truncateTitle(content);
      }
    }

    this.writeConversations(botId, convos);
    return message;
  }

  markInboxStatus(botId: string, conversationId: string, status: InboxStatus): Conversation | null {
    const convos = this.readConversations(botId);
    const idx = convos.findIndex((c) => c.id === conversationId);
    if (idx === -1) return null;
    convos[idx].inboxStatus = status;
    convos[idx].updatedAt = new Date().toISOString();
    this.writeConversations(botId, convos);
    return convos[idx];
  }

  countByInboxStatus(botId: string, status: InboxStatus): number {
    const convos = this.readConversations(botId);
    return convos.filter((c) => c.type === 'inbox' && c.inboxStatus === status).length;
  }

  /** Find an inbox conversation by its askHumanQuestionId. */
  findByQuestionId(botId: string, questionId: string): Conversation | null {
    const convos = this.readConversations(botId);
    return convos.find((c) => c.askHumanQuestionId === questionId) ?? null;
  }

  /** Attach files to an existing message (used by agent loop for retroactive file attachment). */
  attachFiles(botId: string, conversationId: string, messageId: string, files: FileRef[]): boolean {
    if (!files.length) return false;
    const msgPath = this.messagesPath(botId, conversationId);
    if (!existsSync(msgPath)) return false;
    const lines = readFileSync(msgPath, 'utf-8').trim().split('\n').filter(Boolean);
    let found = false;
    const updated = lines.map((line) => {
      let msg: ThreadMessage;
      try { msg = JSON.parse(line); } catch { return line; }
      if (msg.id === messageId) {
        found = true;
        msg.files = [...(msg.files ?? []), ...files];
        return JSON.stringify(msg);
      }
      return line;
    });
    if (!found) return false;
    const tmp = msgPath + '.tmp';
    writeFileSync(tmp, updated.join('\n') + '\n', 'utf-8');
    renameSync(tmp, msgPath);
    return true;
  }

  private truncateTitle(text: string, maxLen = 60): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;
    const truncated = clean.slice(0, maxLen);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '...';
  }
}

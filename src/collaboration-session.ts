import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './ollama';

export interface CollaborationSession {
  id: string;
  sourceBotId: string;
  targetBotId: string;
  messages: ChatMessage[];
  createdAt: number;
  lastActivityAt: number;
}

export class CollaborationSessionManager {
  private sessions: Map<string, CollaborationSession> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private sessionTtlMs: number = 600_000) {
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
  }

  create(sourceBotId: string, targetBotId: string): CollaborationSession {
    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    const session: CollaborationSession = {
      id,
      sourceBotId,
      targetBotId,
      messages: [],
      createdAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string): CollaborationSession | undefined {
    return this.sessions.get(sessionId);
  }

  appendMessages(sessionId: string, messages: ChatMessage[]): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages.push(...messages);
      session.lastActivityAt = Date.now();
    }
  }

  end(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Remove sessions that haven't been active within the TTL */
  sweep(): void {
    const cutoff = Date.now() - this.sessionTtlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastActivityAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.sessions.clear();
  }
}

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  constructor(private sessionTtlMs: number = 600_000, private dataDir?: string) {
    if (dataDir) this.loadFromDisk();
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
  }

  /** Load sessions from disk on startup. Runs sweep() to remove expired. */
  loadFromDisk(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'sessions.json');
    if (!existsSync(filePath)) return;

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (raw.sessions && typeof raw.sessions === 'object') {
        for (const [id, session] of Object.entries(raw.sessions)) {
          this.sessions.set(id, session as CollaborationSession);
        }
      }
      this.sweep();
    } catch {
      // Ignore corrupt file
    }
  }

  /** Persist sessions to disk. */
  private persistToDisk(): void {
    if (!this.dataDir) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const data = { sessions: Object.fromEntries(this.sessions) };
      writeFileSync(join(this.dataDir, 'sessions.json'), JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Swallow write errors (non-critical)
    }
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
    this.persistToDisk();
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
      this.persistToDisk();
    }
  }

  end(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.persistToDisk();
  }

  /** Remove sessions that haven't been active within the TTL */
  sweep(): void {
    const sizeBefore = this.sessions.size;
    const cutoff = Date.now() - this.sessionTtlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastActivityAt < cutoff) {
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size !== sizeBefore) this.persistToDisk();
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.sessions.clear();
  }
}

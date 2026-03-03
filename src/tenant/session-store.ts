import { randomBytes } from 'node:crypto';

export interface Session {
  id: string;
  role: 'admin' | 'tenant';
  tenantId?: string;
  name: string;
  createdAt: number;
  expiresAt: number;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  createSession(data: { role: 'admin' | 'tenant'; tenantId?: string; name: string }): Session {
    const id = `sess_${randomBytes(32).toString('hex')}`;
    const now = Date.now();
    const session: Session = {
      id,
      role: data.role,
      tenantId: data.tenantId,
      name: data.name,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(id);
      }
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}

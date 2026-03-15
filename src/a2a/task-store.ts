import type { A2AMessage, Artifact, Task, TaskState } from './types';

export interface TaskStoreConfig {
  maxTasks?: number;
  ttlMs?: number; // TTL for completed/failed tasks
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor(private config: TaskStoreConfig = {}) {
    // Periodic prune every 60 seconds
    this.pruneTimer = setInterval(() => this.prune(), 60_000);
  }

  create(id: string, message: A2AMessage, sessionId?: string): Task {
    const task: Task = {
      id,
      sessionId,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      messages: [message],
    };
    this.tasks.set(id, task);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  updateState(id: string, state: TaskState, message?: A2AMessage): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    task.status = { state, message, timestamp: new Date().toISOString() };
    if (message) task.messages.push(message);
    return task;
  }

  addArtifact(id: string, artifact: Artifact): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (!task.artifacts) task.artifacts = [];
    task.artifacts.push(artifact);
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status.state === 'completed' || task.status.state === 'failed') return false;
    task.status = { state: 'canceled', timestamp: new Date().toISOString() };
    return true;
  }

  private prune(): void {
    const ttl = this.config.ttlMs ?? 3_600_000;
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (['completed', 'failed', 'canceled'].includes(task.status.state)) {
        const ts = new Date(task.status.timestamp).getTime();
        if (now - ts > ttl) this.tasks.delete(id);
      }
    }
    // Cap total count
    const max = this.config.maxTasks ?? 1000;
    if (this.tasks.size > max) {
      const entries = [...this.tasks.entries()];
      const toRemove = entries.slice(0, entries.length - max);
      for (const [id] of toRemove) this.tasks.delete(id);
    }
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
    this.tasks.clear();
  }

  listBySession(sessionId: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.sessionId === sessionId);
  }

  get size(): number {
    return this.tasks.size;
  }
}

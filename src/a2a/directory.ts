/**
 * A2A Agent Directory
 *
 * In-memory registry of known A2A agents with heartbeat tracking and skill search.
 */
import type { AgentCard } from './types';

export interface DirectoryEntry {
  card: AgentCard;
  registeredAt: number;
  lastHeartbeat: number;
  healthy: boolean;
}

export interface DirectoryConfig {
  /** How long until an agent is considered stale (ms) */
  staleTtlMs?: number;
  /** Max registered agents */
  maxAgents?: number;
}

export class AgentDirectory {
  private agents = new Map<string, DirectoryEntry>();
  private pruneTimer: ReturnType<typeof setInterval>;
  private staleTtlMs: number;
  private maxAgents: number;

  constructor(config: DirectoryConfig = {}) {
    this.staleTtlMs = config.staleTtlMs ?? 300_000; // 5 min
    this.maxAgents = config.maxAgents ?? 100;
    this.pruneTimer = setInterval(() => this.pruneStale(), 60_000);
  }

  /**
   * Register or update an agent.
   */
  register(card: AgentCard): DirectoryEntry {
    const now = Date.now();
    const existing = this.agents.get(card.name);

    const entry: DirectoryEntry = {
      card,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeat: now,
      healthy: true,
    };

    this.agents.set(card.name, entry);

    // Enforce max
    if (this.agents.size > this.maxAgents) {
      this.evictOldest();
    }

    return entry;
  }

  /**
   * Update heartbeat for an agent.
   */
  heartbeat(name: string): boolean {
    const entry = this.agents.get(name);
    if (!entry) return false;
    entry.lastHeartbeat = Date.now();
    entry.healthy = true;
    return true;
  }

  /**
   * Remove an agent.
   */
  unregister(name: string): boolean {
    return this.agents.delete(name);
  }

  /**
   * Get a single agent by name.
   */
  get(name: string): DirectoryEntry | undefined {
    return this.agents.get(name);
  }

  /**
   * List all agents, optionally filtered by health.
   */
  list(healthyOnly = false): DirectoryEntry[] {
    const entries = [...this.agents.values()];
    if (healthyOnly) return entries.filter((e) => e.healthy);
    return entries;
  }

  /**
   * Search agents by skill keywords.
   */
  searchBySkill(query: string): DirectoryEntry[] {
    const q = query.toLowerCase();
    return this.list(true).filter((entry) =>
      entry.card.skills.some(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.tags?.some((t) => t.toLowerCase().includes(q))
      )
    );
  }

  /**
   * Prune agents that haven't sent a heartbeat within staleTtlMs.
   * Marks them unhealthy rather than removing them.
   */
  pruneStale(): void {
    const cutoff = Date.now() - this.staleTtlMs;
    for (const [_name, entry] of this.agents) {
      if (entry.lastHeartbeat < cutoff) {
        entry.healthy = false;
      }
    }
  }

  private evictOldest(): void {
    let oldestName: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [name, entry] of this.agents) {
      if (entry.lastHeartbeat < oldestTime) {
        oldestTime = entry.lastHeartbeat;
        oldestName = name;
      }
    }
    if (oldestName) this.agents.delete(oldestName);
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
    this.agents.clear();
  }

  get size(): number {
    return this.agents.size;
  }
}

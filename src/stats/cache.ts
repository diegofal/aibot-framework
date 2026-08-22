/**
 * In-memory TTL cache for the expensive stats aggregations (log tail scan,
 * JSONL scans). Keyed by caller-chosen strings such as `fleet:7d`.
 */
export class TtlCache {
  private entries = new Map<string, { expiresAt: number; value: unknown }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get<T>(key: string, ttlMs: number, compute: () => T): T {
    const hit = this.entries.get(key);
    const t = this.now();
    if (hit && hit.expiresAt > t) return hit.value as T;
    const value = compute();
    this.entries.set(key, { expiresAt: t + ttlMs, value });
    return value;
  }

  invalidate(): void {
    this.entries.clear();
  }
}

export const STATS_CACHE_TTL_MS = 60_000;

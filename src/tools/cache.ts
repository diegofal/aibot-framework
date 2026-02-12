const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Simple in-memory TTL cache
 */
export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Remove all expired entries
   */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}

/**
 * Health of the embedding service (plan `docs/plans/watcher-optimizations-plan.md`,
 * O7): Ollama was down for 11 days unnoticed and the watcher's birth ran
 * without embeddings. One `embed("probe")` per `GET /api/stats/infra`,
 * cached `EMBEDDING_PROBE_TTL_MS` (5 min); concurrent requests share the
 * call. `downSince` is the first failed check since the last good one
 * (process-local). Never throws.
 */

export const EMBEDDING_PROBE_TTL_MS = 5 * 60_000;
export const EMBEDDING_PROBE_TIMEOUT_MS = 15_000;
const PROBE_TEXT = 'probe';

export interface EmbeddingHealth {
  /** `soul.search.embeddingModel`; null when none is configured. */
  model: string | null;
  ok: boolean;
  latencyMs: number | null;
  checkedAt: string;
  /** First failed check since the last good one; null while ok. */
  downSince: string | null;
  error?: string;
}

export interface EmbeddingProbeOptions {
  model: string | null | undefined;
  /** One embedding with the configured model; absent → never ok. */
  embed?: (text: string) => Promise<number[]>;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

export class EmbeddingProbe {
  private last: EmbeddingHealth | null = null;
  private lastAt = 0;
  private inflight: Promise<EmbeddingHealth> | null = null;
  private downSinceMs: number | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: EmbeddingProbeOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The cached health, or a fresh probe when the cache is older than the TTL. */
  get(): Promise<EmbeddingHealth> {
    const ttl = this.opts.ttlMs ?? EMBEDDING_PROBE_TTL_MS;
    if (this.last && this.now() - this.lastAt < ttl) return Promise.resolve(this.last);
    if (!this.inflight) {
      this.inflight = this.check().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async check(): Promise<EmbeddingHealth> {
    const at = this.now();
    const model = this.opts.model || null;
    let ok = false;
    let latencyMs: number | null = null;
    let error: string | undefined;
    if (!model || !this.opts.embed) {
      error = 'no embedding model configured (soul.search.embeddingModel)';
    } else {
      const started = Date.now();
      try {
        const vec = await withTimeout(
          this.opts.embed(PROBE_TEXT),
          this.opts.timeoutMs ?? EMBEDDING_PROBE_TIMEOUT_MS
        );
        latencyMs = Date.now() - started;
        ok = Array.isArray(vec) && vec.length > 0;
        if (!ok) error = 'the embedding came back empty';
      } catch (err) {
        latencyMs = Date.now() - started;
        error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      }
    }
    if (ok) this.downSinceMs = null;
    else if (this.downSinceMs === null) this.downSinceMs = at;
    const health: EmbeddingHealth = {
      model,
      ok,
      latencyMs,
      checkedAt: new Date(at).toISOString(),
      downSince: this.downSinceMs === null ? null : new Date(this.downSinceMs).toISOString(),
      ...(error ? { error } : {}),
    };
    this.last = health;
    this.lastAt = at;
    return health;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

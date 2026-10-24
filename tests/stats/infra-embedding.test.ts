import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createStatsContext } from '../../src/stats/context';
import { EMBEDDING_PROBE_TTL_MS, EmbeddingProbe } from '../../src/stats/embedding-probe';
import { buildInfra } from '../../src/stats/infra-aggregator';
import { statsRoutes } from '../../src/web/routes/stats';
import { removeTempDir } from '../helpers/temp-dir';
import { type StatsFixture, createStatsFixture } from './fixture';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

let t: number;
beforeEach(() => {
  t = Date.parse('2026-10-24T10:00:00Z');
});

function probe(embed?: (text: string) => Promise<number[]>, model: string | null = 'nomic') {
  const calls: string[] = [];
  const p = new EmbeddingProbe({
    model,
    ...(embed
      ? {
          embed: (text: string) => {
            calls.push(text);
            return embed(text);
          },
        }
      : {}),
    now: () => t,
  });
  return { p, calls };
}

describe('EmbeddingProbe', () => {
  it('ok with the model and a latency when the embed answers a vector', async () => {
    const { p, calls } = probe(async () => [0.1, 0.2]);
    const h = await p.get();
    expect(h).toMatchObject({ model: 'nomic', ok: true, checkedAt: new Date(t).toISOString() });
    expect(typeof h.latencyMs).toBe('number');
    expect(h.downSince).toBeNull();
    expect(calls).toEqual(['probe']);
  });

  it('caches for 5 minutes, then probes again; concurrent gets share one call', async () => {
    const { p, calls } = probe(async () => [1]);
    await Promise.all([p.get(), p.get()]);
    expect(calls).toHaveLength(1);
    t += EMBEDDING_PROBE_TTL_MS - 1;
    await p.get();
    expect(calls).toHaveLength(1);
    t += 2;
    await p.get();
    expect(calls).toHaveLength(2);
  });

  it('down: the error, and downSince stays at the first failed check until one works', async () => {
    let up = false;
    const { p } = probe(async () => {
      if (!up) throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      return [1];
    });
    const first = await p.get();
    expect(first.ok).toBe(false);
    expect(first.error).toContain('ECONNREFUSED');
    expect(first.downSince).toBe(new Date(t).toISOString());
    const since = first.downSince;
    t += EMBEDDING_PROBE_TTL_MS + 1;
    expect((await p.get()).downSince).toBe(since);
    up = true;
    t += EMBEDDING_PROBE_TTL_MS + 1;
    const back = await p.get();
    expect(back.ok).toBe(true);
    expect(back.downSince).toBeNull();
  });

  it('an empty vector is down; no model configured is down without calling', async () => {
    expect((await probe(async () => []).p.get()).ok).toBe(false);
    const { p, calls } = probe(async () => [1], null);
    const h = await p.get();
    expect(h.ok).toBe(false);
    expect(h.model).toBeNull();
    expect(h.error).toContain('no embedding model');
    expect(calls).toEqual([]);
  });
});

describe('infra: the ollama row carries the embedding health', () => {
  let fx: StatsFixture;
  beforeEach(() => {
    fx = createStatsFixture();
  });
  afterEach(() => removeTempDir(fx.dir));

  it('buildInfra puts it on the ollama row only', () => {
    const ctx = createStatsContext({ config: fx.config, now: () => fx.now });
    const embedding = {
      model: 'nomic',
      ok: true,
      latencyMs: 12,
      checkedAt: new Date(fx.now).toISOString(),
      downSince: null,
    };
    const i = buildInfra(ctx, [fx.bots.b1], { embedding });
    expect(i.backends.find((b) => b.name === 'ollama')?.embedding).toEqual(embedding);
    expect(i.backends.find((b) => b.name === 'claude-cli')).not.toHaveProperty('embedding');
    expect(buildInfra(ctx, [fx.bots.b1]).backends[0]).not.toHaveProperty('embedding');
  });

  it('GET /api/stats/infra probes through the injected probe', async () => {
    const { p, calls } = probe(async () => [1]);
    const app = new Hono();
    app.route(
      '/api/stats',
      statsRoutes({
        config: fx.config,
        botManager: {} as never,
        logger: noopLogger,
        now: () => fx.now,
        embeddingProbe: p,
      })
    );
    const body = (await (await app.request('/api/stats/infra')).json()) as {
      backends: Array<{ name: string; embedding?: { ok: boolean } }>;
    };
    expect(body.backends.find((b) => b.name === 'ollama')?.embedding?.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

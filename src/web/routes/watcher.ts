/**
 * The fleet watcher API (docs/plans/watcher-implementation-plan.md, phase 1).
 * Mounted at `/api/watcher`:
 *
 *   GET  /                 { enabled: false } | { enabled: true, ...WatcherState }
 *   POST /start, /stop     same shape as GET /
 *   GET  /graph            { neurons, edges, linkStatus, rev } (no embeddings, capped at graph.maxNeurons)
 *   GET  /log              { rows } newest first; ?date=YYYY-MM-DD&limit=&before=<seq>
 *   GET  /neurons/:id      { neuron, edges, why }
 *   GET  /birth            birth.json, or {} before birth
 *   GET  /metrics          ?window=7d|30d → the metric table (phase 3)
 *   GET  /broadcasts       { broadcasts } newest first, each with `why`; ?botId=&limit=
 *   POST /neurons/:id/signal  { signal: up|down } on an insight / contradiction /
 *                          prediction (`n-…`) or a broadcast (`b-…`)
 *   GET  /passes           { passes } newest first: what each notice / integrate / introspect
 *                          call saw and said, without prompt and response; ?limit= (O6)
 *   GET  /passes/:id       { pass } one record with its prompt and response
 *   GET  /self             { running, interoception, attention, introspection, subjects } (phase 4)
 *   POST /introspect       ask the watcher what it is doing now: 200 { status: scored, record },
 *                          409 unavailable (asleep / no notice model), 429 refused (budget,
 *                          breaker), 502 failed
 *
 * Admin or single tenant only: a tenant gets 404 on every route (the watcher
 * sees the whole fleet). With the watcher off every route but GET / is 404
 * with `{ enabled: false, error }`.
 */
import { Hono } from 'hono';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import { getTenantId, isAdminOrSingleTenant } from '../../tenant/tenant-scoping';
import type { Broadcast } from '../../watcher/broadcast';
import {
  applyWatcherConfigPatch,
  parseWatcherConfigPatch,
  persistWatcherConfigPatch,
  tierSwitches,
} from '../../watcher/config-file';
import { computeMetrics, parseMetricsWindow } from '../../watcher/metrics';
import { summarizeIntrospection } from '../../watcher/metrics/introspection';
import { loadMetricsRecords } from '../../watcher/metrics/records';
import { passRecordsFor } from '../../watcher/pass-records';
import { watcherDir } from '../../watcher/paths';
import type { Neuron } from '../../watcher/types';
import { WATCHER_DEFAULTS, type WatcherConfig } from '../../watcher/types';
import type { Watcher } from '../../watcher/watcher';
import { broadcastToWhy } from '../../why/builders/broadcast';
import { neuronToWhy } from '../../why/builders/watcher';
import type { CycleReader } from '../../why/cycle-index';

const LOG_DEFAULT_LIMIT = 200;
const LOG_MAX_LIMIT = 1000;
const CYCLE_WINDOW_MS = 86_400_000;
/** Introspection rows `GET /self` returns (all subjects, newest first). */
const SELF_HISTORY_LIMIT = 50;

export interface WatcherRouteDeps {
  config: Config;
  logger: Logger;
  /** The watcher, read per request (absent when `watcher.enabled` is off). */
  watcher: () => Watcher | undefined;
  /** Cycle-log rows, for the cycle a neuron came from in its `why`. */
  readCycles?: CycleReader;
  /** Live Claude CLI semaphore (conversation-latency guard); absent = no reading. */
  semaphore?: () => { queuedInteractive: number; activeWatcher: number };
  now?: () => number;
  /**
   * The config file the process loaded (`loadConfig(path)`). `POST /config`
   * persists into it; absent → the change is live only (`persisted: false`).
   */
  configPath?: string;
}

export function watcherRoutes(deps: WatcherRouteDeps): Hono {
  const app = new Hono();
  const cfg = (): WatcherConfig =>
    (deps.config.watcher as WatcherConfig | undefined) ?? WATCHER_DEFAULTS;
  const live = (): Watcher | undefined => (cfg().enabled ? deps.watcher() : undefined);
  const notFound = { error: 'Not found' };
  /** Every 404 while the watcher is off: the page switches to its off state on `enabled: false`. */
  const off = { enabled: false, error: 'The watcher is off' };

  app.use('*', async (c, next) => {
    if (!isAdminOrSingleTenant(getTenantId(c))) return c.json(notFound, 404);
    return next();
  });

  app.get('/', (c) => {
    const w = live();
    return c.json(
      w ? { enabled: true, ...w.state(), config: tierSwitches(cfg()) } : { enabled: false }
    );
  });

  /**
   * Turn the notice / integrate tiers on or off and set their daily caps
   * without a restart: `{ notice?: { enabled?, maxPerDay? }, integrate?: … }`.
   * Persisted first (validated, `.bak`, atomic), then applied live; the
   * watcher starts or stops its timers (`applyConfig`).
   */
  app.post('/config', async (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    const parsed = parseWatcherConfigPatch(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (deps.configPath) {
      const saved = persistWatcherConfigPatch(deps.configPath, parsed.patch);
      if (!saved.ok) return c.json({ error: saved.error }, saved.status);
    }
    const next = applyWatcherConfigPatch(deps.config, parsed.patch);
    w.applyConfig();
    deps.logger.info({ patch: parsed.patch }, 'Watcher: tier config changed');
    return c.json({
      enabled: true,
      ...w.state(),
      config: tierSwitches(next),
      persisted: !!deps.configPath,
    });
  });

  app.post('/start', async (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    return c.json({ enabled: true, ...(await w.start()) });
  });

  app.post('/stop', async (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    return c.json({ enabled: true, ...(await w.stop()) });
  });

  app.get('/graph', (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    const snap = w.graph.snapshot();
    const max = cfg().graph.maxNeurons;
    const neurons =
      snap.neurons.length > max ? [...snap.neurons].sort(byRecentLive).slice(0, max) : snap.neurons;
    const kept = new Set(neurons.map((n) => n.id));
    const edges = snap.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
    return c.json({ neurons, edges, linkStatus: w.state().linkStatus, rev: snap.rev });
  });

  app.get('/log', (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    const date = c.req.query('date');
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
    }
    const limit = clampInt(c.req.query('limit'), LOG_DEFAULT_LIMIT, 1, LOG_MAX_LIMIT);
    const beforeRaw = c.req.query('before');
    const before =
      beforeRaw !== undefined && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
    const rows = date ? w.log.read(date, { limit, before }) : w.log.recent(limit, before);
    return c.json({ rows });
  });

  app.get('/neurons/:id', (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    const neuron = w.graph.get(c.req.param('id'));
    if (!neuron) return c.json(notFound, 404);
    const edges = w.graph.edgesOf(neuron.id);
    const why = neuronToWhy({
      neuron,
      edges,
      neighbours: w.graph.neighbours(neuron.id),
      ...(cycleRowOf(deps, neuron) ?? {}),
    });
    return c.json({ neuron, edges, why });
  });

  app.get('/birth', (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    return c.json(w.readBirth() ?? {});
  });

  app.get('/metrics', (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    const window = parseMetricsWindow(c.req.query('window'));
    if (!window) return c.json({ error: 'window must be 7d or 30d' }, 400);
    const records = loadMetricsRecords({
      config: deps.config,
      dir: w.dir,
      neurons: () => w.graph.list(),
      nowMs: (deps.now ?? Date.now)(),
      window,
      ...(deps.semaphore ? { semaphore: deps.semaphore } : {}),
    });
    return c.json(computeMetrics(records, window));
  });

  app.get('/self', (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    const all = w.introspection();
    return c.json({
      running: w.state().running,
      interoception: w.interoception(),
      attention: w.attention(),
      introspection: all.slice(0, SELF_HISTORY_LIMIT),
      subjects: summarizeIntrospection(all),
    });
  });

  /**
   * Run daily maintenance now (forget, relayout, kick the embed-and-link
   * backfill) and answer what it did: `{ forgotten, link, linking, at }`. Never
   * waits on the backfill: `link` only when it settled at once, else
   * `linking: true`. 409 while asleep or while a run is in flight; 500 when the
   * run failed or a stop cancelled it.
   */
  app.post('/maintain', async (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    if (!w.state().running) return c.json({ error: 'The watcher is asleep' }, 409);
    if (w.maintenanceInFlight()) return c.json({ error: 'Maintenance is already running' }, 409);
    const out = await w.maintainNow();
    if (!out) return c.json({ error: 'Maintenance did not complete (see the log)' }, 500);
    return c.json(out);
  });

  app.post('/introspect', async (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    const out = await w.introspect('manual');
    if (out.status === 'scored') return c.json(out);
    if (out.status === 'unavailable') return c.json(out, 409);
    if (out.status === 'refused') return c.json(out, 429);
    return c.json(out, 502);
  });

  app.get('/broadcasts', (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    const limit = clampInt(c.req.query('limit'), BROADCASTS_DEFAULT_LIMIT, 1, BROADCASTS_MAX_LIMIT);
    const botId = c.req.query('botId') || undefined;
    const broadcasts = w.broadcaster.list({ ...(botId ? { botId } : {}), limit }).map((b) => {
      const insight = w.graph.get(b.insightId);
      const servedCycle = servedCycleRow(deps, b);
      return {
        ...b,
        why: broadcastToWhy({
          broadcast: b,
          ...(insight ? { insight } : {}),
          ...(servedCycle ? { servedCycle } : {}),
          botName: botNameOf(deps.config, w, b.botId),
        }),
      };
    });
    return c.json({ broadcasts });
  });

  /** What the watcher's model saw and said, per call (`src/watcher/pass-records.ts`). */
  app.get('/passes', (c) => {
    if (!live()) return c.json(off, 404);
    const limit = clampInt(c.req.query('limit'), PASSES_DEFAULT_LIMIT, 1, PASSES_MAX_LIMIT);
    return c.json({ passes: passRecordsFor(watcherDir(deps.config)).list(limit) });
  });

  app.get('/passes/:id', (c) => {
    if (!live()) return c.json(off, 404);
    const pass = passRecordsFor(watcherDir(deps.config)).get(c.req.param('id'));
    return pass ? c.json({ pass }) : c.json(notFound, 404);
  });

  /** 👍/👎 on an insight, contradiction or prediction (`n-…`), or a broadcast (`b-…`). */
  app.post('/neurons/:id/signal', async (c) => {
    const w = live();
    if (!w) return c.json(off, 404);
    const body = (await c.req.json().catch(() => null)) as { signal?: unknown } | null;
    const signal = body?.signal;
    if (signal !== 'up' && signal !== 'down') {
      return c.json({ error: 'signal must be "up" or "down"' }, 400);
    }
    const id = c.req.param('id');
    if (id.startsWith('b-')) {
      const broadcast = w.signalBroadcast(id, signal);
      return broadcast ? c.json({ broadcast }) : c.json(notFound, 404);
    }
    const neuron = w.signalNeuron(id, signal);
    return neuron ? c.json({ neuron }) : c.json(notFound, 404);
  });

  return app;
}

const BROADCASTS_DEFAULT_LIMIT = 50;
const PASSES_DEFAULT_LIMIT = 100;
const PASSES_MAX_LIMIT = 500;
const BROADCASTS_MAX_LIMIT = 200;

function botNameOf(config: Config, w: Watcher, botId: string): string {
  return (
    w.graph.findByKey(`bot:${botId}`)?.meta?.name ??
    config.bots.find((b) => b.id === botId)?.name ??
    botId
  );
}

function servedCycleRow(deps: WatcherRouteDeps, b: Broadcast) {
  if (!deps.readCycles || !b.servedByCycle) return undefined;
  try {
    const at = Date.parse(b.servedAt ?? b.createdAt);
    return deps
      .readCycles(b.botId, at - 2 * CYCLE_WINDOW_MS, at + CYCLE_WINDOW_MS)
      .find((r) => r.cycleId === b.servedByCycle);
  } catch (err) {
    deps.logger.debug({ err, botId: b.botId }, 'Watcher route: cycle log unreadable');
    return undefined;
  }
}

function byRecentLive(a: Neuron, b: Neuron): number {
  if (!a.archivedAt !== !b.archivedAt) return a.archivedAt ? 1 : -1;
  return b.lastActivatedAt.localeCompare(a.lastActivatedAt);
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback;
  return Math.min(max, Math.max(min, n));
}

function cycleRowOf(deps: WatcherRouteDeps, neuron: Neuron) {
  const cycleId = neuron.support.cycles?.[0];
  const botId = neuron.support.bots[0];
  if (!deps.readCycles || !cycleId || !botId) return undefined;
  try {
    const at = Date.parse(neuron.createdAt);
    const row = deps
      .readCycles(botId, at - 30 * CYCLE_WINDOW_MS, at + CYCLE_WINDOW_MS)
      .find((r) => r.cycleId === cycleId);
    return row ? { cycle: row } : undefined;
  } catch (err) {
    deps.logger.debug({ err, botId }, 'Watcher route: cycle log unreadable');
    return undefined;
  }
}

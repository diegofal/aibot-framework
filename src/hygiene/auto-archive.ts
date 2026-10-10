/**
 * auto-archive — the scheduled half of productions-triage.
 *
 * Once a day (`productions.autoArchive`, on by default) every bot whose
 * productions are on gets `productions-triage` applied with `archiveStale`:
 * outputs nobody reviewed for `staleDays` (clock from the first unreviewed row
 * after the last verdict) move into `archived/`. Files you approved are never
 * candidates. Archive never deletes; runs land in the hygiene history like a
 * manual run. A failing bot is logged and never stops the others.
 *
 * Hosted next to the hygiene routes in src/web/server.ts, which owns the
 * registry: no new service, no agent-loop coupling.
 */

import type { Config } from '../config';
import type { Logger } from '../logger';
import { isEnabled as productionsEnabled } from '../productions/paths';
import type { HygieneRunRequest } from './registry';
import type { HygieneRun } from './types';

const DEFAULT_STALE_DAYS = 7;
const DEFAULT_INTERVAL_HOURS = 24;
/** First run a few minutes after boot, so a restart loop does not hammer the disk. */
const DEFAULT_START_DELAY_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;

export interface AutoArchiveSettings {
  enabled: boolean;
  staleDays: number;
  intervalHours: number;
}

/** The slice of HygieneRegistry this needs (structural, for tests). */
export interface AutoArchiveRegistry {
  run(req: HygieneRunRequest): Promise<HygieneRun>;
}

export interface AutoArchiveSummary {
  bots: number;
  archived: number;
  /** Bots whose run threw or reported an error. */
  failed: string[];
}

interface TimerHandle {
  unref?: () => void;
}

export interface AutoArchiveTimers {
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  setInterval: (fn: () => void, ms: number) => TimerHandle;
  clear: (handle: TimerHandle) => void;
}

const realTimers: AutoArchiveTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clear: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** `productions.autoArchive` with defaults; off whenever productions are off globally. */
export function resolveAutoArchive(config: Config): AutoArchiveSettings {
  // Partial: tests and the effective-config path build Config without Zod defaults.
  const raw: Partial<AutoArchiveSettings> | undefined = config.productions?.autoArchive;
  return {
    enabled: config.productions?.enabled !== false && raw?.enabled !== false,
    staleDays: positive(raw?.staleDays, DEFAULT_STALE_DAYS),
    intervalHours: positive(raw?.intervalHours, DEFAULT_INTERVAL_HOURS),
  };
}

/** Called with the files a bot just had archived unread (none → not called). */
export type OnArchived = (botId: string, files: string[]) => void;

/** One pass over the fleet. Never throws. */
export async function runAutoArchive(deps: {
  registry: AutoArchiveRegistry;
  config: Config;
  logger: Logger;
  onArchived?: OnArchived;
}): Promise<AutoArchiveSummary> {
  const { registry, config, logger } = deps;
  const { staleDays } = resolveAutoArchive(config);
  const summary: AutoArchiveSummary = { bots: 0, archived: 0, failed: [] };
  for (const bot of config.bots ?? []) {
    if (!productionsEnabled(config, bot.id)) continue;
    summary.bots += 1;
    try {
      const run = await registry.run({
        routine: 'productions-triage',
        botId: bot.id,
        apply: true,
        options: { archiveStale: true, staleDays },
      });
      if (run.error) summary.failed.push(bot.id);
      const archived = run.applied.filter((a) => a.action === 'archive');
      summary.archived += archived.length;
      reportArchived(deps, bot.id, run, archived);
    } catch (err) {
      summary.failed.push(bot.id);
      logger.warn({ err, botId: bot.id }, 'auto-archive: productions-triage failed');
    }
  }
  logger.info(summary, 'auto-archive: stale productions archived');
  return summary;
}

function reportArchived(
  deps: { onArchived?: OnArchived; logger: Logger },
  botId: string,
  run: HygieneRun,
  archived: HygieneRun['applied']
): void {
  if (!deps.onArchived || archived.length === 0) return;
  const fileOf = new Map(run.findings.map((f) => [f.id, f.file]));
  const files = archived
    .map((a) => fileOf.get(a.findingId))
    .filter((f): f is string => typeof f === 'string' && f.length > 0);
  if (files.length === 0) return;
  try {
    deps.onArchived(botId, files);
  } catch (err) {
    deps.logger.warn({ err, botId }, 'auto-archive: onArchived failed');
  }
}

/**
 * Schedule `runAutoArchive`: once after `startDelayMs`, then every
 * `intervalHours`. Returns null when disabled. Timers are unref'd so they
 * never keep the process alive.
 */
export function startAutoArchive(deps: {
  registry: AutoArchiveRegistry;
  config: Config;
  logger: Logger;
  onArchived?: OnArchived;
  timers?: AutoArchiveTimers;
  startDelayMs?: number;
}): { stop: () => void } | null {
  const settings = resolveAutoArchive(deps.config);
  if (!settings.enabled) return null;
  const timers = deps.timers ?? realTimers;
  const handles: TimerHandle[] = [];
  const tick = () => {
    void runAutoArchive(deps);
  };
  const first = timers.setTimeout(() => {
    tick();
    const every = timers.setInterval(tick, settings.intervalHours * HOUR_MS);
    every.unref?.();
    handles.push(every);
  }, deps.startDelayMs ?? DEFAULT_START_DELAY_MS);
  first.unref?.();
  handles.push(first);
  deps.logger.info(settings, 'auto-archive: scheduled');
  return {
    stop: () => {
      for (const h of handles) timers.clear(h);
    },
  };
}

/**
 * Everything that gives `bots[].enabled` runtime meaning: boot-time start,
 * the operator escape hatch, and the error the start guard raises.
 *
 * Before this existed, `src/index.ts` never called `startBot()`: the only
 * callers were the dashboard route, its multi-tenant equivalent, and the
 * auto-restart timer for a bot that was *already* running. So every process
 * restart — host reboot, OOM kill, `docker compose up -d --build` — came up
 * with zero running bots and stayed there until a human clicked Start.
 * `restart: unless-stopped` restarts the container, not the bot.
 *
 * Kept free of BotManager internals (leaf imports only) so the policy can be
 * tested without Telegram, and so the web routes can import the error type
 * without pulling in the whole bot graph.
 */
import type { BotConfig } from '../config';
import type { Logger } from '../logger';
import { describeTelegramStartFailure, isTelegramConflictError } from './telegram-errors';

/** Escape hatch for a cutover: the container should be up, but nothing polling. */
export const AUTO_START_ENV_VAR = 'AIBOT_AUTOSTART_BOTS';

/**
 * Raised by `BotManager.startBot()` when asked to start a bot whose config says
 * `enabled: false`. A distinct type so `POST /api/agents/:id/start` can answer
 * with an actionable 4xx instead of a generic 500.
 */
export class BotDisabledError extends Error {
  readonly code = 'agent_disabled';

  constructor(readonly botId: string) {
    super(
      `Agent "${botId}" is disabled (enabled: false) and will not be started. Enable it first — ` +
        `PATCH /api/agents/${botId} {"enabled":true} — or start it with ?enable=true to enable and go live in one step.`
    );
    this.name = 'BotDisabledError';
  }
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export interface AutoStartDecision {
  enabled: boolean;
  source: 'env' | 'config';
}

/**
 * `AIBOT_AUTOSTART_BOTS` overrides `startup.autoStartBots`.
 *
 * The env var wins on purpose: during a cutover the config file lives inside a
 * Docker volume, while `.env` is right there next to `docker compose up`. An
 * unparseable value falls back to the file rather than guessing — but says so,
 * because silently ignoring the one lever meant to keep a bot off the token is
 * exactly the failure this whole module exists to prevent.
 */
export function resolveAutoStart(opts: {
  configured?: boolean;
  env?: Record<string, string | undefined>;
  logger?: Logger;
}): AutoStartDecision {
  const configured = opts.configured ?? true;
  const raw = (opts.env ?? process.env)[AUTO_START_ENV_VAR];
  const normalized = raw?.trim().toLowerCase();

  if (normalized === undefined || normalized === '')
    return { enabled: configured, source: 'config' };
  if (TRUE_VALUES.has(normalized)) return { enabled: true, source: 'env' };
  if (FALSE_VALUES.has(normalized)) return { enabled: false, source: 'env' };

  opts.logger?.warn(
    { [AUTO_START_ENV_VAR]: raw, fallback: configured },
    `${AUTO_START_ENV_VAR} is not a boolean (accepted: true/false/1/0/yes/no/on/off) — falling back to startup.autoStartBots`
  );
  return { enabled: configured, source: 'config' };
}

export interface AutoStartFailure {
  botId: string;
  reason: string;
  /** Another process is already polling this token — the botched-cutover case. */
  conflict: boolean;
}

export interface AutoStartResult {
  started: string[];
  skippedDisabled: string[];
  skippedAlreadyRunning: string[];
  /** Not attempted because shutdown began mid-sequence. */
  notAttempted: string[];
  failed: AutoStartFailure[];
}

export interface AutoStartDeps {
  bots: BotConfig[];
  startBot: (bot: BotConfig) => Promise<void>;
  logger: Logger;
  isRunning?: (botId: string) => boolean;
  isShuttingDown?: () => boolean;
}

/**
 * Starts every `enabled` bot, sequentially, and never rejects.
 *
 * Sequential because that is what the dashboard's *Start All* already does, and
 * because each start does real work — `getMe`, soul migration, soul loader I/O,
 * a spawned health check — that is better serialised than raced on a 1 GB VPS.
 * The ordering also makes the log readable, which matters when one bot out of
 * five fails.
 *
 * A failure is per-bot by construction: one bot that cannot come up must not
 * take the others, or the process, with it.
 */
export async function autoStartEnabledBots(deps: AutoStartDeps): Promise<AutoStartResult> {
  const { bots, logger, startBot } = deps;
  const result: AutoStartResult = {
    started: [],
    skippedDisabled: [],
    skippedAlreadyRunning: [],
    notAttempted: [],
    failed: [],
  };

  const candidates: BotConfig[] = [];
  for (const bot of bots) {
    if (bot.enabled === false) {
      result.skippedDisabled.push(bot.id);
      continue;
    }
    candidates.push(bot);
  }

  if (result.skippedDisabled.length > 0) {
    logger.info(
      { bots: result.skippedDisabled },
      'Auto-start: skipping disabled agents (enabled: false)'
    );
  }

  if (candidates.length === 0) {
    logger.info(
      { total: bots.length },
      'Auto-start: no enabled agents to start — nothing will poll Telegram until an agent is enabled and started'
    );
    return result;
  }

  logger.info({ bots: candidates.map((b) => b.id) }, 'Auto-starting enabled agents');

  for (const bot of candidates) {
    if (deps.isShuttingDown?.()) {
      result.notAttempted.push(bot.id);
      continue;
    }
    if (deps.isRunning?.(bot.id)) {
      result.skippedAlreadyRunning.push(bot.id);
      continue;
    }

    try {
      await startBot(bot);
      result.started.push(bot.id);
    } catch (err) {
      const conflict = isTelegramConflictError(err);
      const reason = describeTelegramStartFailure(err);
      result.failed.push({ botId: bot.id, reason, conflict });
      logger.error(
        { err, botId: bot.id, conflict },
        `Auto-start failed for agent "${bot.id}" — continuing with the remaining agents. ${reason}`
      );
    }
  }

  if (result.notAttempted.length > 0) {
    logger.warn(
      { bots: result.notAttempted },
      'Auto-start interrupted by shutdown — these agents were never started'
    );
  }

  logger.info(
    {
      started: result.started,
      failed: result.failed.map((f) => f.botId),
      skippedDisabled: result.skippedDisabled,
      skippedAlreadyRunning: result.skippedAlreadyRunning,
    },
    'Auto-start complete'
  );

  if (result.started.length === 0 && result.failed.length > 0) {
    logger.error(
      { failed: result.failed.map((f) => f.botId) },
      'Auto-start started NO agents — every enabled agent failed. Nothing is answering messages.'
    );
  }

  return result;
}

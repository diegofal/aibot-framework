/**
 * `resolveSelfImprove`: defaults → global `agentLoop.selfImprove` → the bot's
 * `agentLoop.selfImprove` (any field it sets wins).
 */
import type { BotConfig, Config } from '../../config';
import type { ResolvedSelfImprove } from './types';

export const SELF_IMPROVE_DEFAULTS: ResolvedSelfImprove = Object.freeze({
  enabled: false,
  minRepeats: 3,
  maxActive: 5,
  measureCalls: 20,
  measureDays: 5,
  minDrop: 0.5,
});

type Partialish = Partial<Record<keyof ResolvedSelfImprove, unknown>> | undefined;

function pick(base: ResolvedSelfImprove, over: Partialish): ResolvedSelfImprove {
  if (!over) return base;
  const out = { ...base };
  for (const k of Object.keys(base) as (keyof ResolvedSelfImprove)[]) {
    const v = over[k];
    if (v !== undefined && typeof v === typeof base[k]) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function resolveSelfImprove(
  config: Pick<Config, 'agentLoop'> | undefined,
  bot: Pick<BotConfig, 'agentLoop'> | undefined
): ResolvedSelfImprove {
  const global = (config?.agentLoop as { selfImprove?: Partialish } | undefined)?.selfImprove;
  const own = (bot?.agentLoop as { selfImprove?: Partialish } | undefined)?.selfImprove;
  return pick(pick({ ...SELF_IMPROVE_DEFAULTS }, global), own);
}

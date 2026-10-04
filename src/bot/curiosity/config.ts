import type { CuriosityConfig } from '../../config';
import type {
  CuriosityPresetId,
  FrontierItem,
  LimitDial,
  LimitDials,
  ResolvedCuriosity,
} from './types';
import { LIMIT_DIALS } from './types';

/** The three starting points for the six limit dials. */
export const CURIOSITY_PRESETS: Record<CuriosityPresetId, LimitDials> = {
  focused: {
    topic: 'closed',
    purpose: 'closed',
    instructions: 'closed',
    method: 'open',
    capability: 'closed',
    identity: 'closed',
  },
  explorer: {
    topic: 'open',
    purpose: 'ask',
    instructions: 'ask',
    method: 'open',
    capability: 'ask',
    identity: 'closed',
  },
  wild: {
    topic: 'open',
    purpose: 'open',
    instructions: 'open',
    method: 'open',
    capability: 'open',
    identity: 'ask',
  },
};

/** Code-level defaults: curiosity is DNA, so it is on without any config. */
export const CURIOSITY_DEFAULTS = {
  enabled: true,
  preset: 'explorer' as CuriosityPresetId,
  exploreRatio: 0.25,
  maxTopicShare: 0.6,
  topicWindow: 8,
  directiveHalfLifeOutputs: 3,
  directiveHalfLifeDays: 7,
  navigatorEvery: '1d',
  noSurpriseStreak: 3,
  dispatch: {
    enabled: true,
    maxChars: 1200,
    minEditorScore: 0.7,
    baseIntervalHours: 12,
    minIntervalHours: 4,
    maxIntervalHours: 168,
  },
};

/** Hard ceiling on the explore share, whatever the trait says. */
export const MAX_EXPLORE_RATIO = 0.6;

/** `30m` / `12h` / `1d` → ms. Kept local so this package never imports agent-loop. */
export function parseEveryMs(raw: string, fallbackMs = 86_400_000): number {
  const m = /^(\d+)\s*(m|h|d)$/i.exec(raw.trim());
  if (!m) return fallbackMs;
  const n = Number.parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  return n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
}

/**
 * The `curiosity` trait (0.1–0.9) scales the configured explore share by
 * 0.6×–1.4× (0.5 = unchanged), capped at MAX_EXPLORE_RATIO.
 */
export function scaleExploreRatio(base: number, curiosityTrait: number | undefined): number {
  if (curiosityTrait === undefined || Number.isNaN(curiosityTrait)) return base;
  const scaled = base * (0.5 + curiosityTrait);
  return Math.max(0, Math.min(MAX_EXPLORE_RATIO, scaled));
}

/**
 * Layering: code defaults → global → per-bot; dials are preset (per-bot ??
 * global ?? explorer) overlaid with global explicit dials, then per-bot
 * explicit dials; finally the curiosity trait scales the explore share.
 */
export function resolveCuriosity(
  global: CuriosityConfig | undefined,
  bot: CuriosityConfig | undefined,
  curiosityTrait?: number
): ResolvedCuriosity {
  const d = CURIOSITY_DEFAULTS;
  const preset = bot?.preset ?? global?.preset ?? d.preset;
  const limits: LimitDials = { ...CURIOSITY_PRESETS[preset] };
  for (const layer of [global?.limits, bot?.limits]) {
    if (!layer) continue;
    for (const dial of LIMIT_DIALS) {
      const v = layer[dial];
      if (v) limits[dial] = v;
    }
  }

  const pick = <K extends keyof NonNullable<CuriosityConfig>>(key: K) =>
    bot?.[key] ?? global?.[key];

  const gd = global?.dispatch;
  const bd = bot?.dispatch;
  const minI = bd?.minIntervalHours ?? gd?.minIntervalHours ?? d.dispatch.minIntervalHours;
  const maxI = Math.max(
    minI,
    bd?.maxIntervalHours ?? gd?.maxIntervalHours ?? d.dispatch.maxIntervalHours
  );
  const baseI = Math.min(
    maxI,
    Math.max(minI, bd?.baseIntervalHours ?? gd?.baseIntervalHours ?? d.dispatch.baseIntervalHours)
  );

  return {
    enabled: (pick('enabled') as boolean | undefined) ?? d.enabled,
    preset,
    limits,
    exploreRatio: scaleExploreRatio(
      (pick('exploreRatio') as number | undefined) ?? d.exploreRatio,
      curiosityTrait
    ),
    maxTopicShare: (pick('maxTopicShare') as number | undefined) ?? d.maxTopicShare,
    topicWindow: (pick('topicWindow') as number | undefined) ?? d.topicWindow,
    directiveHalfLifeOutputs:
      (pick('directiveHalfLifeOutputs') as number | undefined) ?? d.directiveHalfLifeOutputs,
    directiveHalfLifeDays:
      (pick('directiveHalfLifeDays') as number | undefined) ?? d.directiveHalfLifeDays,
    navigatorEveryMs: parseEveryMs(
      (pick('navigatorEvery') as string | undefined) ?? d.navigatorEvery
    ),
    noSurpriseStreak: (pick('noSurpriseStreak') as number | undefined) ?? d.noSurpriseStreak,
    dispatch: {
      enabled: bd?.enabled ?? gd?.enabled ?? d.dispatch.enabled,
      maxChars: bd?.maxChars ?? gd?.maxChars ?? d.dispatch.maxChars,
      minEditorScore: bd?.minEditorScore ?? gd?.minEditorScore ?? d.dispatch.minEditorScore,
      baseIntervalHours: baseI,
      minIntervalHours: minI,
      maxIntervalHours: maxI,
    },
  };
}

export interface FrontierVerdict {
  allowed: boolean;
  /** Dials this item crosses at all. */
  crosses: LimitDial[];
  /** Crossed `ask` dials not yet approved by the operator. */
  needsApproval: LimitDial[];
  /** Crossed `closed` dials — never selectable. */
  blockedBy: LimitDial[];
}

/** Which dials a frontier item crosses: topic past distance 1, purpose without a bridge. */
export function frontierCrossings(item: FrontierItem): LimitDial[] {
  const crosses: LimitDial[] = [];
  if (item.distance >= 2) crosses.push('topic');
  if (!item.bridge?.trim()) crosses.push('purpose');
  return crosses;
}

/**
 * May the bot explore this frontier item on its own? `closed` dials block,
 * `ask` dials need operator approval (`operatorSignal: 'up'`), `open` dials
 * pass. An operator 'down' always blocks.
 */
export function evaluateFrontierItem(item: FrontierItem, limits: LimitDials): FrontierVerdict {
  const crosses = frontierCrossings(item);
  const blockedBy = crosses.filter((dial) => limits[dial] === 'closed');
  const approved = item.operatorSignal === 'up';
  const needsApproval = approved ? [] : crosses.filter((dial) => limits[dial] === 'ask');
  const allowed =
    item.operatorSignal !== 'down' && blockedBy.length === 0 && needsApproval.length === 0;
  return { allowed, crosses, needsApproval, blockedBy };
}

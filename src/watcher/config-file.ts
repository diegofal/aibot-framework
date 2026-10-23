/**
 * Live switches for the watcher's LLM tiers (`POST /api/watcher/config`): a
 * small patch of `notice` / `integrate` `{ enabled?, maxPerDay? }`, applied
 * to the live config object and persisted into the config file the process
 * loaded. The file is read raw (its `${VAR}` references stay as written),
 * only the patched fields change, the merged `watcher` block must pass
 * `WatcherConfigSchema` once its `${VAR}` references are expanded (as
 * `loadConfig` does; the file keeps the references), and the file is
 * rewritten through `patchConfigFile` (atomic, no `.bak`).
 */
import { type Config, WatcherConfigSchema, expandEnvReferences, patchConfigFile } from '../config';
import { WATCHER_DEFAULTS, type WatcherConfig } from './types';

export type WatcherTierName = 'notice' | 'integrate';
export interface TierPatch {
  enabled?: boolean;
  maxPerDay?: number;
}
export type WatcherConfigPatch = Partial<Record<WatcherTierName, TierPatch>>;

const TIERS: readonly WatcherTierName[] = ['notice', 'integrate'];
const TIER_FIELDS = new Set(['enabled', 'maxPerDay']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Validate a request body into a patch; anything else is an error in words. */
export function parseWatcherConfigPatch(
  body: unknown
): { ok: true; patch: WatcherConfigPatch } | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: 'Body must be a JSON object' };
  const patch: WatcherConfigPatch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!TIERS.includes(key as WatcherTierName)) {
      return { ok: false, error: `Unknown field "${key}" (only notice and integrate)` };
    }
    if (!isPlainObject(value)) return { ok: false, error: `${key} must be an object` };
    const tier: TierPatch = {};
    for (const [field, v] of Object.entries(value)) {
      if (!TIER_FIELDS.has(field)) {
        return { ok: false, error: `Unknown field "${key}.${field}" (only enabled and maxPerDay)` };
      }
      if (field === 'enabled') {
        if (typeof v !== 'boolean') return { ok: false, error: `${key}.enabled must be a boolean` };
        tier.enabled = v;
      } else {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          return { ok: false, error: `${key}.maxPerDay must be a whole number ≥ 0` };
        }
        tier.maxPerDay = v;
      }
    }
    if (Object.keys(tier).length > 0) patch[key as WatcherTierName] = tier;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to change' };
  return { ok: true, patch };
}

/**
 * Merge the patch into the config file at `configPath`. Validates the merged
 * `watcher` block before writing; on any failure the file is untouched.
 */
export function persistWatcherConfigPatch(
  configPath: string,
  patch: WatcherConfigPatch
): { ok: true } | { ok: false; error: string; status: 400 | 500 } {
  let invalid: string | undefined;
  try {
    patchConfigFile(configPath, (raw) => {
      const watcher = isPlainObject(raw.watcher) ? { ...raw.watcher } : {};
      for (const tier of TIERS) {
        const p = patch[tier];
        if (!p) continue;
        watcher[tier] = { ...(isPlainObject(watcher[tier]) ? watcher[tier] : {}), ...p };
      }
      // Validated as loadConfig will see it (`${VAR}` expanded), written raw.
      const check = WatcherConfigSchema.safeParse(expandEnvReferences(watcher));
      if (!check.success) {
        invalid = `The watcher block of the config file would not validate: ${check.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`;
        throw new Error(invalid);
      }
      raw.watcher = watcher;
    });
  } catch (err) {
    if (invalid) return { ok: false, status: 400, error: invalid };
    return { ok: false, status: 500, error: `Could not update ${configPath}: ${message(err)}` };
  }
  return { ok: true };
}

/**
 * Apply the patch to the live config the watcher reads (`config.watcher`).
 * Replaces the tier objects instead of mutating them: they may be shared
 * with `WATCHER_DEFAULTS`.
 */
export function applyWatcherConfigPatch(config: Config, patch: WatcherConfigPatch): WatcherConfig {
  const current = (config.watcher as WatcherConfig | undefined) ?? WATCHER_DEFAULTS;
  const next: WatcherConfig = { ...current };
  for (const tier of TIERS) {
    const p = patch[tier];
    if (p) next[tier] = { ...current[tier], ...p } as never;
  }
  (config as { watcher?: WatcherConfig }).watcher = next;
  return next;
}

/** The switches and caps the page shows. */
export function tierSwitches(cfg: WatcherConfig): Record<WatcherTierName, Required<TierPatch>> {
  return {
    notice: { enabled: cfg.notice.enabled, maxPerDay: cfg.notice.maxPerDay },
    integrate: { enabled: cfg.integrate.enabled, maxPerDay: cfg.integrate.maxPerDay },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-bot relay settings with their defaults (`bots[].relay`). */
import type { RelayLocale } from './format';

export interface ResolvedRelayConfig {
  enabled: boolean;
  peerToPeer: boolean;
  locale: RelayLocale;
}

export const RELAY_DEFAULTS: ResolvedRelayConfig = {
  enabled: true,
  peerToPeer: false,
  locale: 'es',
};

export function resolveRelayConfig(
  bot: { relay?: Partial<ResolvedRelayConfig> } | undefined
): ResolvedRelayConfig {
  return { ...RELAY_DEFAULTS, ...(bot?.relay ?? {}) };
}

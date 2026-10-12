/**
 * Who may relay to whom. Operator and users share one mechanism; they differ
 * only here.
 */
import type { RelayParty } from './types';

export type RelayDecision = { allowed: true } | { allowed: false; reason: string };

export interface RelayPolicyOptions {
  /** `bots[].relay.peerToPeer`: allow relays between two non-operator people. */
  peerToPeer: boolean;
}

export const PEER_TO_PEER_REFUSAL =
  'Relaying between two non-operator users is disabled for this bot (relay.peerToPeer). Ask the operator instead.';

/**
 * - `from` null (the bot itself, e.g. the agent loop) → allowed;
 * - anyone → operator, operator → anyone → allowed;
 * - person → person → only with `peerToPeer`.
 * The refusal reason is written to be returned as tool output.
 */
export function canRelay(
  from: RelayParty | null,
  to: RelayParty,
  opts: RelayPolicyOptions
): RelayDecision {
  if (!from) return { allowed: true };
  if (from.isOperator || to.isOperator) return { allowed: true };
  if (opts.peerToPeer) return { allowed: true };
  return { allowed: false, reason: PEER_TO_PEER_REFUSAL };
}

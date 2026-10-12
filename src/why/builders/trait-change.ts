/**
 * Why for one trait change (Agent Home → Traits history): which traits moved
 * by how much, the reason the proposer stated per trait when it proposed them
 * (strategist `trait_reasons`, recorded in the TRAITS.json snapshot), the cycle
 * that proposed it, and the operator policy when a pinned or locked trait
 * refused the proposal. No stated reason → `missing`, never a guess.
 */
import { type CycleRow, toWhyCycle } from '../cycle-index';
import type { Why, WhyActor } from '../types';

/** One entry of a bot's trait history, as `readTraitChanges` assembles it. */
export interface TraitChangeRecord {
  /** ISO time of the snapshot. */
  ts: string;
  /** `strategist` | `reflection` | `adaptive` | `pinned` */
  source: string;
  cycleId: string | null;
  /** Applied deltas; `requested` is absent when reconstructed from snapshots. */
  changes: Array<{ trait: string; from: number; to: number; requested?: number }>;
  /** Proposals the operator's policy refused. */
  rejected: Array<{ trait: string; requested: number; rule: 'pinned' | 'locked' }>;
  /** Stated reason per trait. */
  reasons: Record<string, string>;
  /** True when diffed from two snapshots written before changes were recorded. */
  derived: boolean;
}

export interface TraitChangeWhyInput {
  botId: string;
  change: TraitChangeRecord;
  /** The cycle-log row of `change.cycleId`, when the log still has it. */
  cycle?: CycleRow;
}

const ACTORS: Record<string, WhyActor> = {
  strategist: 'strategist',
  reflection: 'reflection',
  pinned: 'operator',
  adaptive: 'system',
};

const SOURCES: Record<string, string> = {
  strategist: 'Strategist',
  reflection: 'Reflection',
};

const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function traitChangeToWhy({ botId, change: c, cycle }: TraitChangeWhyInput): Why {
  const moved = c.changes.map((x) => `${x.trait} ${signed(round2(x.to - x.from))}`);
  const what =
    moved.length > 0
      ? `Trait${moved.length === 1 ? '' : 's'} adjusted: ${moved.join(', ')}`
      : `Trait proposal refused: ${c.rejected.map((r) => r.trait).join(', ') || 'none'}`;
  const why: Why = { what };
  const by = ACTORS[c.source];
  if (by) why.by = by;

  const missing: string[] = [];
  if (c.cycleId) {
    why.cycle = cycle ? toWhyCycle(botId, cycle) : { id: c.cycleId, botId };
    if (!cycle) missing.push('The cycle log has no record of this cycle, so its plan is unknown.');
  }

  const traits = [...c.changes.map((x) => x.trait), ...c.rejected.map((r) => r.trait)];
  const stated = traits
    .filter((t) => typeof c.reasons[t] === 'string' && c.reasons[t].trim())
    .map((t) => [t, c.reasons[t].trim()] as const);
  if (stated.length > 0) {
    why.reason = {
      text: traits.length === 1 ? stated[0][1] : stated.map(([t, r]) => `${t}: ${r}`).join(' · '),
      source: SOURCES[c.source] ?? 'Recorded',
    };
  } else if (c.source === 'strategist' || c.source === 'reflection') {
    missing.push('No reason was recorded with this change (proposals before 2026-10-12 had none).');
  }

  const rules: string[] = [];
  if (c.source === 'pinned') rules.push('Pinned by you in the agent config.');
  for (const x of c.changes) {
    if (typeof x.requested !== 'number') continue;
    const applied = round2(x.to - x.from);
    if (Math.abs(x.requested) - Math.abs(applied) > 0.005 && Math.abs(applied) > 0) {
      rules.push(
        `${x.trait}: asked ${signed(x.requested)}, applied ${signed(applied)} (capped per pass or by the 0.1–0.9 range).`
      );
    }
  }
  for (const r of c.rejected) {
    rules.push(`${r.trait} is ${r.rule} by you, so ${signed(r.requested)} was ignored.`);
  }
  if (rules.length > 0) why.rule = rules.join(' ');

  why.outcome =
    c.changes.length > 0
      ? c.changes.map((x) => `${x.trait} ${x.from.toFixed(2)} → ${x.to.toFixed(2)}`).join(', ')
      : 'Nothing changed.';
  if (c.derived) {
    missing.push(
      'Reconstructed from two consecutive trait snapshots: what was proposed was not recorded.'
    );
  }
  if (missing.length > 0) why.missing = missing.join(' ');
  return why;
}

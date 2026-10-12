/**
 * Why for one karma event (Karma page history): the kind in words, who caused
 * it, the cycle and goal it was scored in (`metadata.cycleId` / `goalId`,
 * plan and goal title from the cycle log), the production it is about, the
 * reward rule, and the delta with its recorded reason.
 */
import type { KarmaEvent, KarmaOutcomeKind } from '../../karma/types';
import { type CycleRow, toWhyCycle } from '../cycle-index';
import type { Why, WhyActor } from '../types';

export interface KarmaEventWhyInput {
  event: KarmaEvent;
  /** The cycle-log row of `metadata.cycleId`, when the log still has it. */
  cycle?: CycleRow;
}

/** Event types without an outcome kind, told apart by source and reason. */
type LegacyKind = 'repeat' | 'template' | 'manual' | 'other';

interface KindInfo {
  what: string;
  by?: WhyActor;
  rule?: string;
  /** Scored inside an agent-loop cycle, so a missing cycle is worth saying. */
  cycle?: 'always' | 'sometimes';
}

const KINDS: Record<KarmaOutcomeKind | LegacyKind, KindInfo> = {
  novelAction: {
    what: 'A cycle finished with a plan that was not a repeat',
    by: 'agent',
    rule: 'A completed, non-repeated cycle earns karma.rewards.novelAction (0 by default: activity alone is not impact).',
    cycle: 'always',
  },
  repeat: {
    what: 'A cycle repeated a recent plan',
    by: 'agent',
    rule: 'A cycle whose plan repeats one of its recent actions costs 2.',
    cycle: 'always',
  },
  toolError: {
    what: 'A tool call failed',
    by: 'agent',
    rule: 'Every failed tool call costs karma, except when a site blocked the request or a command only exited non-zero.',
    cycle: 'sometimes',
  },
  template: {
    what: 'It wrote an empty template as a production',
    by: 'agent',
    rule: 'A production that is mostly an unfilled template costs 3.',
    cycle: 'sometimes',
  },
  productionApproved: {
    what: 'You approved one of its productions',
    by: 'operator',
    rule: 'Approving a production credits karma.rewards.productionApproved.',
  },
  productionRejected: {
    what: 'You rejected one of its productions',
    by: 'operator',
    rule: 'Rejecting a production costs karma.rewards.productionRejected.',
  },
  productionIgnored: {
    what: 'Productions were archived without being read',
    rule: 'Productions archived unread (from Needs You or by the daily auto-archive) cost karma, at most once a day.',
  },
  askAnswered: {
    what: 'A question it asked was answered',
    by: 'operator',
    rule: 'An answered ask_human question credits karma.rewards.askAnswered.',
  },
  humanReply: {
    what: 'A person replied to it',
    rule: 'A human reply credits karma.rewards.humanReply, at most once per cooldown.',
  },
  collaborateCompleted: {
    what: 'A collaboration with another agent finished',
    by: 'agent',
    rule: 'A finished collaboration earns karma.rewards.collaborateCompleted (0 by default).',
  },
  manual: { what: 'Manual adjustment', by: 'operator' },
  other: { what: 'Karma event' },
};

function kindOf(e: KarmaEvent): KarmaOutcomeKind | LegacyKind {
  if (e.kind && e.kind in KINDS) return e.kind;
  if (e.source === 'manual') return 'manual';
  if (e.source === 'agent-loop' && e.reason.startsWith('Repeated action')) return 'repeat';
  if (e.source === 'production' && e.reason.startsWith('Empty template')) return 'template';
  return 'other';
}

const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x : undefined);

function productionHref(botId: string, path: string): string {
  return `#/work/productions/${encodeURIComponent(botId)}?file=${encodeURIComponent(path)}`;
}

/** `+3` / `−1`, with a real minus sign. */
function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}

export function karmaEventToWhy(input: KarmaEventWhyInput): Why {
  const { event: e, cycle } = input;
  const kind = kindOf(e);
  const info = KINDS[kind];
  const meta = e.metadata ?? {};
  const why: Why = { what: kind === 'other' ? `Karma event (${e.source})` : info.what };
  if (info.by) why.by = info.by;

  const cycleId = str(meta.cycleId);
  const missing: string[] = [];
  if (cycleId) {
    why.cycle = cycle ? toWhyCycle(e.botId, cycle) : { id: cycleId, botId: e.botId };
    if (!cycle) missing.push('The cycle log has no record of this cycle, so its plan is unknown.');
  } else if (info.cycle === 'always') {
    missing.push('No record of the cycle that produced it (written before cycles were logged).');
  } else if (info.cycle === 'sometimes') {
    missing.push(
      'No cycle recorded: it happened outside an agent-loop cycle (in a conversation), or before cycles were logged.'
    );
  }
  const goalTitle = str(cycle?.goalTitle);
  if (goalTitle) {
    const goalId = str(meta.goalId) ?? str(cycle?.goalId);
    why.goal = { ...(goalId ? { id: goalId } : {}), title: goalTitle };
  }

  if (info.rule) why.rule = info.rule;

  const path = str(meta.path);
  const paths = Array.isArray(meta.paths) ? meta.paths.filter((p) => str(p)) : [];
  if (path) {
    why.related = {
      label: 'Production',
      items: [{ text: path, href: productionHref(e.botId, path) }],
    };
  } else if (paths.length > 0) {
    why.related = {
      label: 'Productions',
      items: paths.map((p: string) => ({ text: p, href: productionHref(e.botId, p) })),
    };
  }

  why.outcome = `${signed(e.delta)} karma: ${e.reason || 'no reason recorded'}`;
  if (missing.length > 0) why.missing = missing.join(' ');
  return why;
}

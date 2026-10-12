/**
 * Why for a production file (Needs You and the Productions page): the cycle
 * that wrote its latest version (`ProductionEntry.cycleId`), that cycle's
 * plan and goal, the tool, when and how the file was created, and its review
 * state as the outcome.
 */
import type { ProductionEntry } from '../../productions/types';
import { type CycleRow, cycleAttribution } from '../cycle-index';
import type { Why } from '../types';
import { NO_CYCLE_TEXT, UNLOGGED_CYCLE_TEXT } from './ask';

export interface ProductionWhyInput {
  /** The file's latest content row (create or edit). */
  entry: ProductionEntry;
  /** The cycle-log row for `entry.cycleId`, when the log has it. */
  cycle?: CycleRow;
  /** The row that created the file, when it is not `entry` (see `fileHistory`). */
  created?: ProductionEntry;
  /** The cycle-log row for `created.cycleId`. */
  createdCycle?: CycleRow;
  /** Edits since the creation, `entry` included. */
  edits?: number;
  /** Waiting again: the verdict an earlier version had before the agent edited it. */
  priorVerdict?: { status: 'approved' | 'rejected'; at: string } | null;
}

const day = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : '');
const VERDICT_WORD = { approved: 'approved', rejected: 'rejected' } as const;

/** One sentence: where the file stands with the operator. */
export function productionOutcome(
  entry: ProductionEntry,
  prior?: ProductionWhyInput['priorVerdict']
): string {
  const status = entry.evaluation?.status;
  if (status === 'approved' || status === 'rejected') {
    const on = day(entry.evaluation?.evaluatedAt);
    return `You ${VERDICT_WORD[status]} it${on ? ` on ${on}` : ''}.`;
  }
  if (prior && VERDICT_WORD[prior.status]) {
    const on = day(prior.at);
    return `You ${VERDICT_WORD[prior.status]} an earlier version${on ? ` on ${on}` : ''}; it edited the file since, so it waits for your review again.`;
  }
  return 'Waiting for your review.';
}

/**
 * The file's history up to `latest`: the row that created it (unset when
 * `latest` is that row), the edits since (`latest` included) and the last
 * verdict an earlier version got. An archive or delete of the path starts
 * over, like `pendingFiles`.
 */
export function fileHistory(
  entries: ProductionEntry[],
  latest: ProductionEntry,
  normalize: (path: string) => string = (p) => p
): {
  created: ProductionEntry | undefined;
  edits: number;
  priorVerdict: ProductionWhyInput['priorVerdict'];
} {
  const key = normalize(latest.path);
  const latestMs = Date.parse(latest.timestamp);
  const sorted = entries
    .filter((e) => e && typeof e.path === 'string' && Date.parse(e.timestamp) <= latestMs)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let created: ProductionEntry | undefined;
  let edits = 0;
  let priorVerdict: ProductionWhyInput['priorVerdict'] = null;
  for (const e of sorted) {
    const path = e.action === 'archive' && e.archivedFrom ? e.archivedFrom : e.path;
    if (normalize(path) !== key) continue;
    if (e.action === 'create') {
      created = e;
      edits = 0;
    } else if (e.action === 'edit') {
      edits++;
    } else {
      created = undefined;
      edits = 0;
      priorVerdict = null;
      continue;
    }
    if (e.id === latest.id) break;
    const status = e.evaluation?.status;
    if (status === 'approved' || status === 'rejected') {
      priorVerdict = { status, at: e.evaluation?.evaluatedAt || e.timestamp };
    }
  }
  return { created: created?.id === latest.id ? undefined : created, edits, priorVerdict };
}

export function productionToWhy(p: ProductionWhyInput): Why {
  const e = p.entry;
  const tool = (e.tool ?? '').trim();
  const verb = e.action === 'edit' ? 'Last edited' : 'Created';
  const { cycle, goal, unlogged } = cycleAttribution(e.botId, e, p.cycle);
  const why: Why = { what: tool ? `${verb} with ${tool}` : `${verb} by the agent`, by: 'agent' };
  if (cycle) why.cycle = cycle;
  if (goal) why.goal = goal;
  if (p.created) {
    const plan = p.createdCycle?.planSummary;
    why.related = {
      label: 'History',
      items: [
        {
          text: p.created.tool ? `Created with ${p.created.tool}` : 'Created',
          at: p.created.timestamp,
          ...(plan ? { detail: plan } : {}),
        },
      ],
      ...(p.edits ? { note: `Edited ${p.edits} time${p.edits === 1 ? '' : 's'} since.` } : {}),
    };
  }
  why.outcome = productionOutcome(e, p.priorVerdict);
  if (!cycle) why.missing = NO_CYCLE_TEXT;
  else if (unlogged) why.missing = UNLOGGED_CYCLE_TEXT;
  return why;
}

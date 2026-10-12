/**
 * Where a dispatch came from, for the operator reading it.
 *
 * New dispatches record their origin when they are written (runner.ts). For
 * the ones written before that, the origin is inferred at read time: the
 * agent loop runs one cycle per bot at a time and the dispatch is written
 * inside the cycle, so the cycle whose [startedAt, endedAt] contains the
 * dispatch's `createdAt` is the one that produced it. Pure; never throws.
 */
import type { Dispatch, DispatchOrigin, DispatchTrigger } from './types';

/** The fields of an `<data>/agent-cycles` row this module reads. */
export interface CycleRow {
  cycleId: string;
  startedAt: string;
  endedAt?: string;
  planSummary?: string | null;
  goalId?: string | null;
  goalTitle?: string | null;
}

export interface DigestSource {
  id: string;
  hook: string;
  createdAt: string;
  editorScore: number;
}

/** Digests summarise at most this many held findings (`buildDigestCandidate`). */
const DIGEST_MAX_SOURCES = 3;

export function triggerOfDispatch(d: Dispatch): DispatchTrigger {
  if (d.kind === 'digest') return 'digest';
  if (d.kind === 'proposal') return d.interest ? 'interest' : 'frontier';
  return 'insight';
}

/** The recorded origin, else one inferred from the cycle log, else undefined. */
export function inferOrigin(d: Dispatch, cycles: CycleRow[]): DispatchOrigin | undefined {
  if (d.origin) return d.origin;
  const at = Date.parse(d.createdAt);
  if (!Number.isFinite(at)) return undefined;
  const row = cycles.find((c) => {
    const start = Date.parse(c.startedAt);
    const end = c.endedAt ? Date.parse(c.endedAt) : Number.NaN;
    return start <= at && at <= end;
  });
  if (!row) return undefined;
  const origin: DispatchOrigin = { trigger: triggerOfDispatch(d), cycleId: row.cycleId };
  if (row.goalId) origin.goalId = row.goalId;
  if (row.goalTitle) origin.goalTitle = row.goalTitle;
  if (row.planSummary) origin.plan = row.planSummary;
  origin.inferred = true;
  return origin;
}

const toSource = (d: Dispatch): DigestSource => ({
  id: d.id,
  hook: d.hook,
  createdAt: d.createdAt,
  editorScore: d.editorScore,
});

/**
 * The findings a digest summarised: its recorded `sourceIds`, else the
 * strongest non-digest findings of the same bot written before it and after
 * the last digest that was sent (a sent digest consumes what was held).
 */
export function digestSources(
  d: Dispatch,
  all: Dispatch[]
): { inferred: boolean; items: DigestSource[] } | undefined {
  if (d.kind !== 'digest') return undefined;
  const ids = d.origin?.sourceIds;
  if (ids?.length) {
    const byId = new Map(all.map((x) => [x.id, x]));
    const items = ids.flatMap((id) => {
      const x = byId.get(id);
      return x ? [toSource(x)] : [];
    });
    return { inferred: false, items };
  }
  const at = Date.parse(d.createdAt);
  const before = all.filter((x) => x.id !== d.id && Date.parse(x.createdAt) < at);
  const lastSentDigest = before
    .filter((x) => x.kind === 'digest' && x.status === 'sent')
    .reduce((max, x) => Math.max(max, Date.parse(x.createdAt)), Number.NEGATIVE_INFINITY);
  const items = before
    .filter(
      (x) => x.kind !== 'digest' && x.status !== 'sent' && Date.parse(x.createdAt) > lastSentDigest
    )
    .sort((a, b) => b.editorScore - a.editorScore)
    .slice(0, DIGEST_MAX_SOURCES)
    .map(toSource);
  return { inferred: true, items };
}

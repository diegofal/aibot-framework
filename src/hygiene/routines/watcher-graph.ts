/**
 * watcher-graph — the fleet watcher's graph, cleaned (plan
 * `docs/plans/watcher-optimizations-plan.md`, O5).
 *
 * Birth imported every memory line before the bookkeeping filter existed:
 * date headers ("**[2026-10-16]**") and operational traces rank for unrelated
 * queries, and a bot's near-duplicate memory lines link mostly to each other.
 *
 *  - `date-header-fact` / `bookkeeping-fact`: a live `fact` neuron from birth
 *    (`meta.stage` `birth:*`) that is a bare date header or fails
 *    `isBookkeepingLine` (the predicate birth now applies) → archived.
 *  - `duplicate-facts`: live `fact` neurons of the same bot whose texts are
 *    ≥ `DUPLICATE_THRESHOLD` similar (`textSimilarity`) → merged into the
 *    newest (a later line is the likelier correction; `Graph.mergeInto`:
 *    activations summed, support unioned, edges re-pointed, the rest archived
 *    with `meta.mergedInto`). Two texts that differ in a negation or in a
 *    number/date (`contradicts`) are never duplicates, however similar: "will
 *    pay" and "will not pay" are a fact and its correction.
 *  - `graph-summary`: the counts (info, never fixable).
 *
 * The graph is owned by the running watcher, so the routine only ever goes
 * through `deps.watcherGraph` (the live `Watcher.graph`), never the files.
 * Nothing is deleted: an archived neuron stays in the graph and a firing
 * brings it back. Not part of the `all` routine: merging is a deliberate act.
 */

import { isBookkeepingLine } from '../../watcher/birth';
import type { Neuron } from '../../watcher/types';
import { contradicts } from '../text-utils';
import type {
  HygieneApplied,
  HygieneApplyResult,
  HygieneContext,
  HygieneFinding,
  HygieneRoutine,
  HygieneSkipped,
  WatcherGraphAccess,
} from '../types';

export const WATCHER_GRAPH_ROUTINE_ID = 'watcher-graph';
/** `textSimilarity` at or above which two facts of one bot are the same fact. */
export const DUPLICATE_THRESHOLD = 0.9;
const ARCHIVED_BY = 'hygiene:watcher-graph';
const FILE = 'watcher/graph';

const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const DATE_HEADER_RE = new RegExp(String.raw`^[#\s*_[(]*${DATE}[\s*_\])]*:?\s*$`);

/** A line that is only a date, maybe bold, bracketed or a heading ("**[2026-10-16]**"). Pure. */
export function isBareDateHeader(text: string): boolean {
  return DATE_HEADER_RE.test((text ?? '').trim());
}

const isLiveFact = (n: Neuron) => n.kind === 'fact' && !n.archivedAt;
const fromBirth = (n: Neuron) => (n.meta?.stage ?? '').startsWith('birth:');

/** The one bot a fact belongs to: its `bot:<id>` creator, else its only supporting bot. */
function botOf(n: Neuron): string | null {
  if (n.createdBy.startsWith('bot:')) return n.createdBy.slice(4);
  return n.support.bots.length === 1 ? n.support.bots[0] : null;
}

const byAge = (a: Neuron, b: Neuron) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);

const clip = (text: string, n = 80) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function graphOf(ctx: HygieneContext): WatcherGraphAccess | undefined {
  try {
    return ctx.deps.watcherGraph?.();
  } catch {
    return undefined;
  }
}

export const watcherGraph: HygieneRoutine = {
  id: WATCHER_GRAPH_ROUTINE_ID,
  name: 'Watcher graph',
  description:
    "Archives the watcher's bookkeeping and date-header facts from birth and merges near-duplicate facts of the same bot into the newest (never a negation or a different number). Goes through the running watcher; never deletes.",
  scope: 'fleet',
  canApply: true,

  preview(ctx: HygieneContext): HygieneFinding[] {
    const graph = graphOf(ctx);
    if (!graph) {
      return [
        {
          id: 'watcher-unavailable',
          kind: 'watcher-unavailable',
          severity: 'info',
          file: null,
          line: null,
          message: 'The watcher is not enabled in this process: there is no graph to clean.',
          fixable: false,
        },
      ];
    }
    const findings: HygieneFinding[] = [];
    const facts = graph.list().filter(isLiveFact).sort(byAge);
    const retiring = new Set<string>();
    let headers = 0;
    let bookkeeping = 0;
    for (const n of facts) {
      if (!fromBirth(n)) continue;
      const header = isBareDateHeader(n.text);
      if (!header && !isBookkeepingLine(n.text)) continue;
      retiring.add(n.id);
      if (header) headers++;
      else bookkeeping++;
      findings.push({
        id: `${header ? 'date-header' : 'bookkeeping'}:${n.id}`,
        kind: header ? 'date-header-fact' : 'bookkeeping-fact',
        severity: 'warn',
        file: FILE,
        line: null,
        message: `${header ? 'Date header' : 'Bookkeeping line'} imported as a fact of ${
          botOf(n) ?? 'the fleet'
        }: "${clip(n.text)}"`,
        fixable: true,
        fix: {
          action: 'archive',
          details: 'Archive the neuron (reversible: a firing revives it).',
        },
        data: { neuronId: n.id },
      });
    }

    const assigned = new Set<string>();
    let groups = 0;
    let duplicates = 0;
    for (const n of facts) {
      if (assigned.has(n.id) || retiring.has(n.id)) continue;
      const bot = botOf(n);
      if (!bot) continue;
      const twins = graph
        .findSimilarText(n.text, DUPLICATE_THRESHOLD)
        .filter(
          (m) =>
            m.id !== n.id &&
            isLiveFact(m) &&
            !assigned.has(m.id) &&
            !retiring.has(m.id) &&
            botOf(m) === bot &&
            byAge(n, m) < 0 &&
            !contradicts(n.text, m.text)
        )
        .sort(byAge);
      if (twins.length === 0) continue;
      assigned.add(n.id);
      for (const m of twins) assigned.add(m.id);
      groups++;
      duplicates += twins.length;
      // Every twin carries n's negations and numbers, so the group agrees; the
      // newest line is the likelier correction and keeps the merged neuron.
      const group = [n, ...twins];
      const keeper = group[group.length - 1];
      const drops = group.slice(0, -1);
      findings.push({
        id: `duplicate:${n.id}`,
        kind: 'duplicate-facts',
        severity: 'info',
        file: FILE,
        line: null,
        message: `${plural(drops.length, 'near-duplicate')} of ${bot}'s fact "${clip(
          keeper.text
        )}" (similarity ≥ ${DUPLICATE_THRESHOLD})`,
        fixable: true,
        fix: {
          action: 'merge',
          details: 'Merge into the newest: activations summed, support unioned, the rest archived.',
        },
        data: { keepId: keeper.id, dropIds: drops.map((m) => m.id) },
      });
    }

    findings.push({
      id: 'graph-summary',
      kind: 'graph-summary',
      severity: 'info',
      file: FILE,
      line: null,
      message: `${plural(facts.length, 'live fact')}: ${plural(headers, 'date header')}, ${plural(
        bookkeeping,
        'bookkeeping line'
      )}, ${plural(duplicates, 'near-duplicate')} in ${plural(groups, 'group')}.`,
      fixable: false,
      data: { facts: facts.length, headers, bookkeeping, duplicates, groups },
    });
    return findings;
  },

  apply(ctx: HygieneContext, findings: HygieneFinding[]): HygieneApplyResult {
    const applied: HygieneApplied[] = [];
    const skipped: HygieneSkipped[] = [];
    const graph = graphOf(ctx);
    for (const f of findings) {
      if (!f.fixable) continue;
      if (!graph) {
        skipped.push({ findingId: f.id, reason: 'the watcher graph is not available' });
        continue;
      }
      if (f.kind === 'date-header-fact' || f.kind === 'bookkeeping-fact') {
        const id = String(f.data?.neuronId ?? '');
        const n = graph.get(id);
        if (!n || !isLiveFact(n)) {
          skipped.push({ findingId: f.id, reason: 'the neuron is gone or already archived' });
          continue;
        }
        graph.patchMeta(id, {
          archivedBy: ARCHIVED_BY,
          archivedReason: f.kind === 'date-header-fact' ? 'date-header' : 'bookkeeping',
        });
        graph.archive(id);
        applied.push({ findingId: f.id, action: 'archive', result: `Archived "${clip(n.text)}"` });
      } else if (f.kind === 'duplicate-facts') {
        const keepId = String(f.data?.keepId ?? '');
        const dropIds = Array.isArray(f.data?.dropIds) ? (f.data.dropIds as string[]) : [];
        const res = graph.mergeInto(keepId, dropIds);
        if (!res || res.archived.length === 0) {
          skipped.push({ findingId: f.id, reason: 'the keeper or its duplicates changed' });
          continue;
        }
        for (const a of res.archived) graph.patchMeta(a.id, { archivedBy: ARCHIVED_BY });
        applied.push({
          findingId: f.id,
          action: 'merge',
          result: `Merged ${plural(res.archived.length, 'duplicate')} into "${clip(
            res.keeper.text
          )}" (${res.keeper.activations} activations, ${plural(res.edges, 'edge')} re-pointed)`,
        });
      }
    }
    return { applied, skipped, backups: [] };
  },
};

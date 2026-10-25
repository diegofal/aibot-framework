/**
 * O10 (`docs/plans/watcher-optimizations-plan.md`): consolidation while the
 * fleet sleeps. Clusters are connected components over `related` edges among
 * live `fact` neurons whose importance (`importance.ts`) is below the
 * forgetting threshold and that are not protected, of one provenance class
 * (`provenanceClass`: a component mixing classes is split by class, so an
 * operator-sourced cluster stays operator-sourced), with at least
 * `consolidate.minCluster` members.
 *
 * One notice-tier call per cluster (the instrumented client: notice budget,
 * fleet breaker, query log as `watcher:consolidate`, a pass record), at most
 * `consolidate.maxClusters` a night, writes a `summary` neuron
 * (`meta.consolidated: 'true'`, `members` = the ids, support = the union,
 * provenance = the strictest of the members). The members are folded into it
 * with `Graph.mergeInto` (archived with `mergedInto`; their edges, topics
 * included, re-pointed onto the summary) and keep `consolidatedInto` and an
 * `archivedReason`. A cluster larger than `CONSOLIDATE_PROMPT_MEMBERS` is split
 * into chunks of at least `minCluster` (or full chunks of the cap when no such
 * split exists; the rest waits for a later night), one call each (each counts
 * against `maxClusters`), so only facts
 * the model saw are merged. Eligibility is checked again when the call returns:
 * a member that became protected or important meanwhile stays live, and if
 * fewer than `minCluster` remain the summary is skipped and logged. The cap
 * (`maxNeurons`) is enforced after the merge, never by evicting a member. A summary that is empty, longer than the members' mean,
 * or names a bot none of them came from is skipped and logged. The night
 * stops when the fleet wakes up (`isQuiet`), the budget or breaker refuses,
 * or the watcher stops. Every row is code-written. Never throws.
 */
import { parseLLMJson } from '../bot/llm-json-parser';
import type { Graph } from './graph';
import { type ImportanceContext, importanceOf } from './importance';
import { placeWithoutEmbedding } from './layout';
import type { InstrumentedClient } from './llm';
import type { WatcherLog } from './log';
import {
  narrateConsolidatePass,
  narrateConsolidateSkipped,
  narrateConsolidated,
} from './narration';
import {
  type Neuron,
  OPERATOR_MESSAGE,
  OPERATOR_SOURCED,
  type Vec3,
  isOperatorSourced,
  mayCarryOperatorMessage,
} from './types';

/** Who may read a neuron, strictest first: the operator's own words, operator material, public. */
export type ProvenanceClass = 'operator-message' | 'operator' | 'public';

export function provenanceClass(n: Pick<Neuron, 'kind' | 'meta'>): ProvenanceClass {
  if (mayCarryOperatorMessage(n)) return 'operator-message';
  if (isOperatorSourced(n)) return 'operator';
  return 'public';
}

export interface Cluster {
  members: Neuron[];
  provenance: ProvenanceClass;
}

/**
 * Most member texts one prompt shows. A larger cluster is split into chunks of
 * at most this many (`chunkCluster`), each its own call: a fact the model never
 * saw is never folded into a summary.
 */
export const CONSOLIDATE_PROMPT_MEMBERS = 40;
const MAX_SUMMARY_CHARS = 400;
const CONSOLIDATE_TEMPERATURE = 0.2;

/** The clusters to consolidate, largest first. Pure over the graph. */
export function findClusters(
  graph: Pick<Graph, 'list' | 'get' | 'edgesOf'>,
  ctx: ImportanceContext,
  opts: { threshold: number; minCluster: number }
): Cluster[] {
  const eligible = new Map<string, ProvenanceClass>();
  for (const n of graph.list()) {
    if (n.archivedAt || n.kind !== 'fact') continue;
    const s = importanceOf(n, ctx);
    if (s.protected || s.score >= opts.threshold) continue;
    eligible.set(n.id, provenanceClass(n));
  }
  const seen = new Set<string>();
  const out: Cluster[] = [];
  for (const [start, cls] of eligible) {
    if (seen.has(start)) continue;
    seen.add(start);
    const ids: string[] = [];
    const queue = [start];
    while (queue.length) {
      const id = queue.pop() as string;
      ids.push(id);
      for (const e of graph.edgesOf(id)) {
        if (e.rel !== 'related') continue;
        const other = e.from === id ? e.to : e.from;
        if (seen.has(other) || eligible.get(other) !== cls) continue;
        seen.add(other);
        queue.push(other);
      }
    }
    if (ids.length < opts.minCluster) continue;
    out.push({
      members: ids.map((id) => graph.get(id)).filter((n): n is Neuron => !!n),
      provenance: cls,
    });
  }
  return out.sort(
    (a, b) => b.members.length - a.members.length || (a.members[0].id < b.members[0].id ? -1 : 1)
  );
}

/**
 * A cluster split into balanced chunks of at most `CONSOLIDATE_PROMPT_MEMBERS`,
 * in member order, each of at least `minCluster` (a smaller chunk would only be
 * skipped). The fewest chunks that fit the prompt give the largest chunks, so
 * if even that split leaves one under `minCluster` (minCluster 30 and 41 facts:
 * 20 + 21) no split works: the cluster gives full chunks of
 * `CONSOLIDATE_PROMPT_MEMBERS` and the remainder stays live for a later night.
 */
export function chunkCluster(cluster: Cluster, minCluster: number): Cluster[] {
  const n = cluster.members.length;
  const cap = CONSOLIDATE_PROMPT_MEMBERS;
  if (n <= cap) return [cluster];
  const chunk = (from: number, to: number): Cluster => ({
    members: cluster.members.slice(from, to),
    provenance: cluster.provenance,
  });
  const parts = Math.ceil(n / cap);
  if (Math.floor(n / parts) < minCluster) {
    return Array.from({ length: Math.floor(n / cap) }, (_, i) => chunk(i * cap, (i + 1) * cap));
  }
  const out: Cluster[] = [];
  for (let i = 0; i < parts; i++) {
    out.push(chunk(Math.floor((i * n) / parts), Math.floor(((i + 1) * n) / parts)));
  }
  return out;
}

export function buildConsolidatePrompt(
  members: Neuron[],
  botName: (id: string) => string
): { system: string; user: string } {
  const shown = members.slice(0, CONSOLIDATE_PROMPT_MEMBERS);
  const lines = shown.map((n) => {
    const bots = [...new Set(n.support.bots)].map(botName).join(', ');
    return `- ${n.text}${bots ? ` (from ${bots})` : ''}`;
  });
  if (members.length > shown.length) {
    lines.push(`- …and ${members.length - shown.length} more facts like these`);
  }
  const system = [
    "You consolidate a fleet watcher's memory while the fleet sleeps.",
    'You get related facts that are rarely used. Write ONE short summary that keeps what they say in common and any specific detail worth keeping.',
    'Rules: shorter than the average fact; no new claims; name only the agents the facts name; no preamble.',
    'Answer with JSON only: {"summary": "..."}',
  ].join('\n');
  const user = `## Facts (${members.length})\n${lines.join('\n')}`;
  return { system, user };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why a summary is unusable, or null. */
export function validateSummary(
  text: string,
  members: Array<Pick<Neuron, 'text' | 'support'>>,
  bots: Array<{ id: string; name: string }>
): string | null {
  const summary = text.trim();
  if (!summary) return 'the summary was empty';
  const mean = members.reduce((s, n) => s + n.text.length, 0) / Math.max(1, members.length);
  if (summary.length > mean) return 'the summary was longer than the facts it would replace';
  const support = new Set(members.flatMap((n) => n.support.bots));
  for (const b of bots) {
    if (support.has(b.id)) continue;
    const named = [b.id, b.name].filter(
      (x) =>
        x && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(x)}($|[^\\p{L}\\p{N}])`, 'iu').test(summary)
    );
    if (named.length) return `it named ${b.name || b.id}, which none of the facts came from`;
  }
  return null;
}

function parseSummary(text: string): string | null {
  const warn = { warn: () => {} };
  return parseLLMJson<string>(text ?? '', warn as never, {
    label: 'watcher consolidate',
    extractPattern: /\{[\s\S]*"summary"[\s\S]*\}/,
    validate: (raw) => (raw && typeof raw.summary === 'string' ? raw.summary : null),
  });
}

export interface ConsolidateDeps {
  graph: Graph;
  log: WatcherLog;
  /** The notice tier's instrumented client (caller `watcher:consolidate`). */
  client: InstrumentedClient;
  importance: () => ImportanceContext;
  threshold: number;
  minCluster: number;
  maxClusters: number;
  /** The fleet's bots (ids and names), for the "names a bot not in support" check. */
  bots: () => Array<{ id: string; name: string }>;
  botName?: (id: string) => string;
  /** No agent-loop cycle runs (`fleetQuiet`); checked before every call. */
  isQuiet: () => boolean;
  isCancelled?: () => boolean;
  logger?: { warn: (obj: object, msg: string) => void };
}

export interface ConsolidateOutcome {
  clusters: number;
  summaries: Neuron[];
  /** Facts folded into summaries. */
  members: number;
  skipped: number;
  stopped?: 'busy' | 'cap' | 'tokens' | 'breaker' | 'cancelled' | 'error';
}

const STOPPED_TEXT: Record<NonNullable<ConsolidateOutcome['stopped']>, string> = {
  busy: 'an agent woke up',
  cap: "today's noticing budget is spent",
  tokens: "today's token budget is spent",
  breaker: 'the backend is rate-limited (circuit open)',
  cancelled: 'the watcher is stopping',
  error: 'an unexpected error (see the server log)',
};

export async function runConsolidation(deps: ConsolidateDeps): Promise<ConsolidateOutcome> {
  const { graph, log } = deps;
  const botName = deps.botName ?? ((id: string) => id);
  const cancelled = () => deps.isCancelled?.() === true;
  const out: ConsolidateOutcome = { clusters: 0, summaries: [], members: 0, skipped: 0 };
  const finish = (): ConsolidateOutcome => {
    log.say(
      'sleep',
      'consolidate:pass',
      narrateConsolidatePass({
        clusters: out.clusters,
        summaries: out.summaries.length,
        members: out.members,
        skipped: out.skipped,
        ...(out.stopped ? { stopped: STOPPED_TEXT[out.stopped] } : {}),
      }),
      out.summaries.length ? { neuronIds: out.summaries.map((s) => s.id) } : {}
    );
    return out;
  };
  try {
    if (!deps.isQuiet()) {
      out.stopped = 'busy';
      return finish();
    }
    const clusters = findClusters(graph, deps.importance(), {
      threshold: deps.threshold,
      minCluster: deps.minCluster,
    })
      .flatMap((c) => chunkCluster(c, deps.minCluster))
      .slice(0, Math.max(0, deps.maxClusters));
    out.clusters = clusters.length;
    for (const cluster of clusters) {
      if (cancelled()) {
        out.stopped = 'cancelled';
        break;
      }
      if (!deps.isQuiet()) {
        out.stopped = 'busy';
        break;
      }
      // Members may have fired or been archived since the clusters were read.
      const stillEligible = (): Neuron[] => {
        const ctx = deps.importance();
        return cluster.members
          .map((n) => graph.get(n.id))
          .filter((n): n is Neuron => {
            if (!n || n.archivedAt) return false;
            const score = importanceOf(n, ctx);
            return !score.protected && score.score < deps.threshold;
          });
      };
      const shown = stillEligible();
      if (shown.length < deps.minCluster) {
        out.skipped++;
        continue;
      }
      const prompt = buildConsolidatePrompt(shown, botName);
      const res = await deps.client.chat(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        { temperature: CONSOLIDATE_TEMPERATURE }
      );
      if (cancelled()) {
        out.stopped = 'cancelled';
        break;
      }
      if (!res.ok && res.reason !== 'error') {
        out.stopped = res.reason;
        break;
      }
      const cost = res.ok
        ? {
            model: res.model,
            tokens: res.tokens,
            ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
            durationMs: res.durationMs,
            source: 'watcher:consolidate',
          }
        : { model: res.model, durationMs: res.durationMs, source: 'watcher:consolidate' };
      // The call took a while: a member may have become support for a served
      // insight, got a 👍, been activated into importance or been archived.
      // Only the members that are still eligible (and were shown) are merged.
      const shownIds = new Set(shown.map((n) => n.id));
      const members = stillEligible().filter((n) => shownIds.has(n.id));
      const changed = shown.length - members.length;
      const skip = (why: string) => {
        out.skipped++;
        log.say(
          'sleep',
          'consolidate:skipped',
          narrateConsolidateSkipped({ members: shown.length, why }),
          { ...cost, neuronIds: shown.map((n) => n.id) }
        );
      };
      if (!res.ok) {
        skip('the model call failed');
        continue;
      }
      if (members.length < deps.minCluster) {
        skip(
          `${changed} of the facts became important or protected while the model wrote, leaving fewer than ${deps.minCluster}`
        );
        continue;
      }
      const parsed = parseSummary(res.text);
      if (parsed === null) {
        skip("the model's answer was not readable JSON");
        continue;
      }
      const text = parsed.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS);
      const invalid = validateSummary(text, members, deps.bots());
      if (invalid) {
        skip(invalid);
        continue;
      }
      const summary = writeSummary(graph, text, members, cluster.provenance, res.model);
      out.summaries.push(summary);
      out.members += members.length;
      log.say(
        'sleep',
        'consolidate:summary',
        narrateConsolidated({
          text,
          members: members.length,
          bots: summary.support.bots.map(botName),
        }),
        { ...cost, neuronIds: [summary.id, ...members.map((n) => n.id)] }
      );
    }
  } catch (err) {
    // never throws: the night ends with what it wrote
    deps.logger?.warn({ err }, 'Watcher: consolidation failed');
    out.stopped = 'error';
  }
  return finish();
}

function union(members: Neuron[], pick: (s: Neuron['support']) => string[] | undefined) {
  const all = members.flatMap((n) => pick(n.support) ?? []);
  return all.length ? [...new Set(all)] : undefined;
}

/** The summary neuron, then the members folded into it. */
function writeSummary(
  graph: Graph,
  text: string,
  members: Neuron[],
  provenance: ProvenanceClass,
  model: string
): Neuron {
  const support: Neuron['support'] = { bots: union(members, (s) => s.bots) ?? [] };
  const cycles = union(members, (s) => s.cycles);
  const conversations = union(members, (s) => s.conversations);
  const paths = union(members, (s) => s.paths);
  if (cycles) support.cycles = cycles;
  if (conversations) support.conversations = conversations;
  if (paths) support.paths = paths;
  // Strictest of the members: any operator material makes it operator-sourced,
  // any member that may carry an operator message's words taints it too.
  const operatorSourced = provenance !== 'public' || members.some((n) => isOperatorSourced(n));
  const operatorMessage =
    provenance === 'operator-message' || members.some((n) => mayCarryOperatorMessage(n));
  const positions = members.map((n) => n.pos).filter((p): p is Vec3 => !!p);
  // The cap is enforced after the merge: adding the summary first would evict
  // the oldest live neuron, maybe a member, which `mergeInto` would then skip.
  const summary = graph.addNeuron(
    {
      kind: 'summary',
      text,
      support,
      createdBy: 'watcher',
      pos: placeWithoutEmbedding({ id: members[0].id, kind: 'summary' }, positions),
      meta: {
        consolidated: 'true',
        members: members.map((n) => n.id).join(','),
        source: 'consolidate',
        model,
        ...(operatorSourced ? { [OPERATOR_SOURCED]: 'true' } : {}),
        [OPERATOR_MESSAGE]: operatorMessage ? 'true' : 'false',
      },
    },
    { deferCap: true }
  );
  const merged = graph.mergeInto(
    summary.id,
    members.map((n) => n.id)
  );
  for (const m of merged?.archived ?? []) {
    graph.patchMeta(m.id, {
      consolidatedInto: summary.id,
      archivedReason: `consolidated into a summary (${summary.id}) of ${members.length} related facts`,
    });
  }
  graph.enforceCap(summary.id);
  return graph.get(summary.id) ?? summary;
}

/**
 * What became of the watcher's broadcasts and predictions (phase 3), read
 * from records only:
 * - a broadcast is served when a completed cycle row of the same bot, ended
 *   after the broadcast, names it in `servesBroadcast` (the planner's
 *   `serves_broadcast`); the first such cycle wins;
 * - a prediction resolves once its `dueAt` passes: a tier 1 call ("did this
 *   happen, given these events?", `{ happened, evidence }`) scores it, and the
 *   answer is stored on the neuron (`resolvedAt`, `happened`, `brier`,
 *   `evidence`, `resolvedModel`). Budget and breaker apply (the instrumented
 *   client); a refused call stops the pass, an unreadable answer leaves the
 *   prediction open. Never throws.
 */
import { parseLLMJson } from '../bot/llm-json-parser';
import type { Broadcast, Broadcaster } from './broadcast';
import type { Graph } from './graph';
import type { InstrumentedClient } from './llm';
import type { WatcherLog } from './log';
import { narratePredictionResolved } from './narration';
import type { Neuron } from './types';

/** Most predictions one resolution pass asks about. */
export const RESOLVE_MAX_PER_PASS = 3;
const MAX_EVENTS = 40;
const EVIDENCE_MAX = 300;

/** The slice of a cycle row the served check reads. */
export interface ServedCycleRow {
  cycleId: string;
  botId?: string;
  endedAt?: string;
  status?: string;
  servesBroadcast?: string;
}

/** Brier score of one forecast: (p − outcome)². A missing probability is 0.5. */
export function brierScore(probability: number, happened: boolean): number {
  const p = Number.isFinite(probability) ? Math.min(1, Math.max(0, probability)) : 0.5;
  const o = happened ? 1 : 0;
  return (p - o) ** 2;
}

/** Unserved broadcasts that a completed cycle served, with that cycle. */
export function servedFromCycles(
  broadcasts: Broadcast[],
  cycles: ServedCycleRow[]
): Array<{ id: string; cycleId: string; at: string }> {
  const out: Array<{ id: string; cycleId: string; at: string }> = [];
  const sorted = [...cycles].sort((a, b) =>
    String(a.endedAt ?? '').localeCompare(String(b.endedAt ?? ''))
  );
  for (const b of broadcasts) {
    if (b.servedByCycle) continue;
    const created = Date.parse(b.createdAt);
    const row = sorted.find(
      (r) =>
        r.servesBroadcast === b.id &&
        r.status === 'completed' &&
        (r.botId === undefined || r.botId === b.botId) &&
        typeof r.endedAt === 'string' &&
        Date.parse(r.endedAt) >= created
    );
    if (row) out.push({ id: b.id, cycleId: row.cycleId, at: row.endedAt as string });
  }
  return out;
}

/** Mark what the cycles served; returns how many changed. */
export function applyServed(
  broadcaster: Pick<Broadcaster, 'list' | 'markServed'>,
  cycles: ServedCycleRow[]
): number {
  let n = 0;
  for (const s of servedFromCycles(broadcaster.list(), cycles)) {
    if (broadcaster.markServed(s.id, s.cycleId, s.at)) n++;
  }
  return n;
}

/** Live, unresolved predictions whose `dueAt` has passed, oldest due first. */
export function duePredictions(graph: Pick<Graph, 'list'>, nowMs: number): Neuron[] {
  return graph
    .list()
    .filter(
      (n) =>
        n.kind === 'prediction' &&
        !n.archivedAt &&
        !n.meta?.resolvedAt &&
        Number.isFinite(Date.parse(n.meta?.dueAt ?? '')) &&
        Date.parse(n.meta?.dueAt as string) <= nowMs
    )
    .sort((a, b) => Date.parse(a.meta?.dueAt ?? '') - Date.parse(b.meta?.dueAt ?? ''));
}

export function parsePredictionResolution(
  text: string,
  logger: { warn: (obj: object, msg: string) => void }
): { happened: boolean; evidence?: string } | null {
  const warnOnly = { warn: (obj: object, msg?: string) => logger.warn(obj, msg ?? '') };
  return parseLLMJson<{ happened: boolean; evidence?: string }>(text ?? '', warnOnly as never, {
    label: 'watcher prediction',
    extractPattern: /\{[\s\S]*"happened"[\s\S]*\}/,
    validate: (raw) => {
      if (!raw || typeof raw !== 'object' || typeof raw.happened !== 'boolean') return null;
      return {
        happened: raw.happened,
        ...(typeof raw.evidence === 'string' && raw.evidence.trim()
          ? { evidence: raw.evidence.trim() }
          : {}),
      };
    },
  });
}

export interface ResolveDeps {
  graph: Pick<Graph, 'list' | 'patchMeta'>;
  client: Pick<InstrumentedClient, 'chat'>;
  log: Pick<WatcherLog, 'say'>;
  now: () => number;
  /** Code-written lines of what happened between two instants (the watcher log). */
  events: (fromMs: number, toMs: number) => string[];
  max?: number;
  logger: { warn: (obj: object, msg: string) => void };
}

const RESOLVE_SYSTEM = [
  'You check whether a prediction about a fleet of AI agents came true.',
  'You get the prediction and what the fleet watcher recorded while it was open.',
  'Judge only from those records; if they do not show it happened, it did not.',
  'Answer with JSON only: {"happened": true | false, "evidence": "one short sentence"}.',
].join('\n');

export async function resolvePredictions(
  deps: ResolveDeps
): Promise<{ resolved: number; stopped?: 'cap' | 'tokens' | 'breaker' }> {
  const due = duePredictions(deps.graph, deps.now()).slice(0, deps.max ?? RESOLVE_MAX_PER_PASS);
  let resolved = 0;
  for (const p of due) {
    const from = Date.parse(p.createdAt);
    const to = Date.parse(p.meta?.dueAt as string);
    const lines = deps.events(from, to).slice(0, MAX_EVENTS);
    const user = [
      `## Prediction\n${p.text}`,
      `## Open from ${p.createdAt} to ${p.meta?.dueAt}`,
      `## What was recorded\n${lines.length ? lines.map((l) => `- ${l}`).join('\n') : '(nothing)'}`,
    ].join('\n\n');
    const res = await deps.client.chat(
      [
        { role: 'system', content: RESOLVE_SYSTEM },
        { role: 'user', content: user },
      ],
      { temperature: 0 }
    );
    if (!res.ok) {
      if (res.reason === 'error') continue;
      return { resolved, stopped: res.reason };
    }
    const answer = parsePredictionResolution(res.text, deps.logger);
    if (!answer) continue;
    const probability = Number(p.meta?.probability);
    const brier = brierScore(probability, answer.happened);
    const at = new Date(deps.now()).toISOString();
    deps.graph.patchMeta(p.id, {
      resolvedAt: at,
      happened: String(answer.happened),
      brier: String(brier),
      resolvedModel: res.model,
      ...(answer.evidence ? { evidence: answer.evidence.slice(0, EVIDENCE_MAX) } : {}),
    });
    deps.log.say(
      'integrate',
      'prediction:resolved',
      narratePredictionResolved({ text: p.text, happened: answer.happened, brier }),
      {
        neuronIds: [p.id],
        model: res.model,
        tokens: res.tokens,
        ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
        durationMs: res.durationMs,
        source: 'watcher:notice',
      }
    );
    resolved++;
  }
  return { resolved, stopped: undefined };
}

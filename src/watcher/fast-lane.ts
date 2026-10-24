/**
 * O1, the fast lane (docs/plans/watcher-optimizations-plan.md): a cross-bot
 * lesson reaches the bots without waiting for integrate. Live, 2026-10-24:
 * the cheap notice model had already kept "web_fetch is blocked by Cloudflare
 * on thelancet.com and medium.com" from two bots; it waited 12 h for an
 * integrate pass that never broadcast it, and a third bot hit the same wall.
 *
 * Right after a notice pass, every neuron it created or recognised that is a
 * `pattern` (or a `fact` at confidence `high`) supported by at least
 * `fastLane.minBots` bots is a candidate (`fastLaneCandidates`): a recognition
 * unions the pass's bots into the neuron's support, so two bots hitting the
 * same wall in different passes qualify on the second. Privacy: the directive
 * quotes the neuron text, so a neuron an operator message supports
 * (`OPERATOR_MESSAGE`) is never a candidate, nor is an `operatorSourced` fact;
 * a pattern resting on bot activity is. Its targets (`fastLaneTargets`) are the
 * eligible bots (enabled, not a customer tenant's: the caller passes them, and
 * the broadcaster refuses a tenant bot anyway) that are NOT among its
 * supporting bots and that relate to it: a `related` edge between the pattern
 * and one of the bot's neurons (supported by the bot, the bot itself, or owned
 * by it), or the pattern names, as a whole word, a tool the bot used in the
 * last 7 days (tool audit). Each target gets one `directive` through the
 * existing `Broadcaster` (its per-bot cap, delivery and records unchanged),
 * `insightId` = the pattern, `source: 'fast-lane'`: never a question, never a
 * goal, never a wake. At most `fastLane.maxPerDay` fast-lane broadcasts per UTC
 * day, counted from the broadcast records. The integrate prompt shows the
 * broadcast next to the pattern ("fast lane"), so integrate does not resend it.
 * Rows are code-written (the pattern text is model text, quoted). Never throws.
 */
import type { BroadcastResult, Broadcaster } from './broadcast';
import type { Graph } from './graph';
import type { WatcherLog } from './log';
import { quoteModelText } from './narration';
import { type Neuron, OPERATOR_MESSAGE, type WatcherConfig, isOperatorSourced } from './types';

export type FastLaneConfig = NonNullable<WatcherConfig['fastLane']>;

/** Mirrors `watcher.fastLane` in `WatcherConfigSchema`. */
export const FAST_LANE_DEFAULTS: FastLaneConfig = { enabled: true, minBots: 2, maxPerDay: 6 };

/** How far back a bot's tool use relates it to a pattern that names the tool. */
export const FAST_LANE_TOOL_WINDOW_MS = 7 * 86_400_000;

export interface FastLaneCandidate {
  neuronId: string;
  /** The supporting bots (never targets). */
  bots: string[];
  text: string;
}

export interface FastLaneTarget {
  botId: string;
  /** `related`: an edge to a neuron of the bot; `tool`: the pattern names a tool it used. */
  via: 'related' | 'tool';
  /** The related neuron id, or the tool name. */
  ref: string;
}

export interface FastLaneTargetContext {
  graph: Pick<Graph, 'get' | 'neighbours'>;
  /** Eligible bots: enabled and not a customer tenant's. */
  bots: string[];
  /** Tool names the bot used in the last 7 days. */
  toolsUsed?: (botId: string) => string[];
}

/** The fast-lane candidates among the neurons a notice pass created or recognised. Pure. */
export function fastLaneCandidates(created: Neuron[], cfg: FastLaneConfig): FastLaneCandidate[] {
  if (!cfg.enabled) return [];
  const out: FastLaneCandidate[] = [];
  for (const n of created) {
    if (n.archivedAt) continue;
    const kindOk = n.kind === 'pattern' || (n.kind === 'fact' && n.confidence === 'high');
    if (!kindOk) continue;
    // Privacy: the directive quotes the text verbatim. Never what an operator
    // message supports, and never an operator-sourced fact (it may be their
    // words); a pattern resting on bot activity is the lesson itself.
    if (n.meta?.[OPERATOR_MESSAGE] === 'true') continue;
    if (n.kind !== 'pattern' && isOperatorSourced(n)) continue;
    const bots = [...new Set(n.support.bots)];
    if (bots.length < cfg.minBots) continue;
    out.push({ neuronId: n.id, bots, text: n.text });
  }
  return out;
}

/** Whether a neuron belongs to a bot: it supports it, it is the bot, or the bot owns it. */
function isNeuronOf(graph: FastLaneTargetContext['graph'], n: Neuron, botId: string): boolean {
  if (n.support.bots.includes(botId)) return true;
  if (n.meta?.key === `bot:${botId}`) return true;
  return graph
    .neighbours(n.id)
    .some(
      ({ neuron, edge }) =>
        edge.rel === 'owned_by' && edge.from === n.id && neuron.meta?.key === `bot:${botId}`
    );
}

/** `web_fetch` in "web_fetch is blocked", never in "my_web_fetcher". */
function namesTool(text: string, tool: string): boolean {
  if (tool.length < 3) return false;
  const escaped = tool.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`).test(text.toLowerCase());
}

/** The bots a candidate goes to, in the order of `ctx.bots`. Pure over the graph. */
export function fastLaneTargets(
  c: FastLaneCandidate,
  ctx: FastLaneTargetContext
): FastLaneTarget[] {
  const supporting = new Set(c.bots);
  const related = ctx.graph
    .neighbours(c.neuronId)
    .filter(({ neuron, edge }) => edge.rel === 'related' && !neuron.archivedAt)
    .map(({ neuron }) => neuron);
  const out: FastLaneTarget[] = [];
  for (const botId of [...new Set(ctx.bots)]) {
    if (supporting.has(botId)) continue;
    const viaEdge = related.find((n) => isNeuronOf(ctx.graph, n, botId));
    if (viaEdge) {
      out.push({ botId, via: 'related', ref: viaEdge.id });
      continue;
    }
    let tools: string[] = [];
    try {
      tools = ctx.toolsUsed?.(botId) ?? [];
    } catch {
      tools = [];
    }
    const tool = tools.find((name) => namesTool(c.text, name));
    if (tool) out.push({ botId, via: 'tool', ref: tool });
  }
  return out;
}

export interface FastLaneDeps {
  graph: Pick<Graph, 'get' | 'neighbours'>;
  broadcaster: Pick<Broadcaster, 'send' | 'list'>;
  log?: Pick<WatcherLog, 'say'>;
  /** The live `watcher.fastLane`. */
  config: () => FastLaneConfig;
  /** Eligible targets: enabled bots that are not a customer tenant's. */
  bots: () => string[];
  /** Tool names a bot used in the last 7 days (tool audit); read at most once per bot per run. */
  toolsUsed?: (botId: string) => string[];
  botName?: (botId: string) => string;
  now: () => number;
  isCancelled?: () => boolean;
  /** Kept by the caller across runs: the UTC day the capped row was written (one per day). */
  state?: { cappedOn?: string };
  logger?: { warn: (obj: object, msg: string) => void };
}

export interface FastLaneOutcome {
  neuronId: string;
  /** Bots whose directive was delivered. */
  sent: string[];
}

/** The directive a target bot's planner gets. */
export function fastLaneDirective(c: FastLaneCandidate, botName: (id: string) => string): string {
  const names = c.bots.map(botName);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `Fleet watcher (fast lane): ${who} both ran into this; it likely applies to you too: ${c.text}`;
}

function narrateFastLane(input: { to: string[]; from: string[]; text: string }): string {
  const list = (xs: string[]) =>
    xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? '');
  return `Fast lane: told ${list(input.to)} what ${list(input.from)} both ran into, without waiting to integrate: ${quoteModelText(input.text)}.`;
}

function narrateFastLaneCapped(maxPerDay: number): string {
  return `Fast lane held: today's ${maxPerDay} fast-lane broadcasts are used; the rest waits for integrate.`;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Sends the fast-lane directives for what a notice pass created or recognised. One row per
 * pattern that reached a bot (`broadcast:fast-lane`), one row per UTC day
 * when the daily cap holds the rest (`broadcast:fast-lane-capped`). Never throws.
 */
export async function runFastLane(
  deps: FastLaneDeps,
  created: Neuron[]
): Promise<FastLaneOutcome[]> {
  const isCancelled = deps.isCancelled ?? (() => false);
  const out: FastLaneOutcome[] = [];
  try {
    const cfg = deps.config();
    const candidates = fastLaneCandidates(created, cfg);
    if (candidates.length === 0) return out;
    const botName = deps.botName ?? ((id: string) => id);
    const tools = new Map<string, string[]>();
    const toolsUsed = deps.toolsUsed
      ? (botId: string) => {
          let t = tools.get(botId);
          if (!t) {
            t = deps.toolsUsed?.(botId) ?? [];
            tools.set(botId, t);
          }
          return t;
        }
      : undefined;
    const today = utcDay(deps.now());
    let usedToday = deps.broadcaster
      .list()
      .filter(
        (b) =>
          b.source === 'fast-lane' &&
          b.createdAt.slice(0, 10) === today &&
          !(b.deferred && !b.deliveredAt)
      ).length;
    const state = deps.state ?? {};
    const capped = () => {
      if (state.cappedOn === today) return;
      state.cappedOn = today;
      deps.log?.say(
        'broadcast',
        'broadcast:fast-lane-capped',
        narrateFastLaneCapped(cfg.maxPerDay),
        {
          source: 'fast-lane',
        }
      );
    };

    for (const c of candidates) {
      if (isCancelled()) return out;
      const targets = fastLaneTargets(c, {
        graph: deps.graph,
        bots: deps.bots(),
        ...(toolsUsed ? { toolsUsed } : {}),
      });
      if (targets.length === 0) continue;
      const sent: string[] = [];
      for (const target of targets) {
        if (isCancelled()) break;
        if (usedToday >= cfg.maxPerDay) {
          capped();
          break;
        }
        let result: BroadcastResult;
        try {
          result = await deps.broadcaster.send({
            botId: target.botId,
            kind: 'directive',
            text: fastLaneDirective(c, botName),
            insightId: c.neuronId,
            reason: c.text,
            source: 'fast-lane',
          });
        } catch (err) {
          deps.logger?.warn({ err }, 'Watcher fast lane: a send threw');
          continue;
        }
        // A record was written (delivered or failed): it took a slot of the day.
        if (result.broadcast && !result.broadcast.deferred) usedToday++;
        if (result.status === 'delivered') sent.push(target.botId);
      }
      if (sent.length === 0) continue;
      deps.log?.say(
        'broadcast',
        'broadcast:fast-lane',
        narrateFastLane({ to: sent.map(botName), from: c.bots.map(botName), text: c.text }),
        { neuronIds: [c.neuronId], source: 'fast-lane' }
      );
      out.push({ neuronId: c.neuronId, sent });
    }
  } catch (err) {
    deps.logger?.warn({ err }, 'Watcher fast lane: run failed');
  }
  return out;
}

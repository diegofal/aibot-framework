/**
 * Navigator — the "self-directed" gene. A layer above the strategist that
 * runs about daily: a retrospective over the knowledge map, the cycle log
 * and the operator's signals, then a direction of 2–3 bets (exploit or
 * explore), frontier updates, served directives, grown interests and goal
 * cleanup. Pure functions plus one LLM call; persistence is the caller's job.
 * See docs/plans/curiosity-navigator-plan.md §3.
 */
import { randomUUID } from 'node:crypto';
import type { LLMClient, TokenUsage } from '../../core/llm-client';
import { textSimilarity } from '../../hygiene/text-utils';
import type { Logger } from '../../logger';
import type { GoalOperation } from '../agent-strategist';
import { parseLLMJson } from '../llm-json-parser';
import type { TopicConcentration } from './cycle';
import { buildDnaSection } from './dna';
import { KNOWLEDGE_CAPS, pruneKnowledgeMap, topicId } from './knowledge-map';
import type {
  CycleMode,
  CycleTopicEntry,
  Direction,
  Dispatch,
  KnowledgeMap,
  LimitDials,
  NavigatorState,
  ResolvedCuriosity,
} from './types';

export const NAVIGATOR_CAPS = {
  bets: 3,
  frontierAdd: 6,
  listItems: 10,
  recentDispatches: 8,
};

const DUP_THRESHOLD = 0.8;
const GOAL_ACTIONS = new Set(['add', 'complete', 'update', 'remove']);

// ── Scheduling ─────────────────────────────────────────────────────────

export function shouldRunNavigator(
  nav: NavigatorState,
  cfg: ResolvedCuriosity,
  nowMs: number
): boolean {
  if (!cfg.enabled) return false;
  // A failed attempt backs off (≤ 2 h) instead of costing two LLM calls every cycle.
  const attempt = nav.lastNavigatorAttemptAt ? Date.parse(nav.lastNavigatorAttemptAt) : Number.NaN;
  if (!Number.isNaN(attempt) && nowMs - attempt < Math.min(cfg.navigatorEveryMs, NAVIGATOR_RETRY_MS)) {
    return false;
  }
  if (!nav.lastNavigatorAt) return true;
  const last = Date.parse(nav.lastNavigatorAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= cfg.navigatorEveryMs;
}

/** Backoff after a failed navigator attempt. */
export const NAVIGATOR_RETRY_MS = 2 * 3_600_000;

// ── Prompt ─────────────────────────────────────────────────────────────

export interface NavigatorPromptInput {
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  /** renderKnowledgeForPrompt output. */
  knowledge: string;
  /** renderFrontierForPrompt output. */
  frontier: string;
  /** renderDirectivesForPrompt output. */
  directives: string;
  /** renderTasteForPrompt output. */
  taste: string;
  recentDispatches: Dispatch[];
  cycleLog: CycleTopicEntry[];
  concentration: TopicConcentration;
  previousDirection: Direction | null;
  limits: LimitDials;
  datetime: string;
}

function summariseCycleLog(log: CycleTopicEntry[], conc: TopicConcentration): string {
  if (log.length === 0) return '## Your recent cycles\n\n(no cycles recorded yet)';
  const counts = new Map<string, number>();
  for (const e of log) counts.set(e.topic, (counts.get(e.topic) ?? 0) + 1);
  const topics = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} ×${n}`)
    .join(', ');
  const explore = log.filter((e) => e.mode === 'explore').length;
  const surprised = log.filter((e) => e.surprised).length;
  const lines = [
    '## Your recent cycles',
    '',
    `- Topics: ${topics}`,
    `- Mix: ${explore} explore / ${log.length - explore} exploit`,
    `- Surprise rate: ${surprised}/${log.length} cycles surprised you (${Math.round((surprised / log.length) * 100)}%)`,
  ];
  if (conc.dominantTopic) {
    lines.push(
      `- Concentration: "${conc.dominantTopic}" took ${conc.count}/${conc.window} of the last cycles (${Math.round(conc.share * 100)}%)`
    );
  }
  return lines.join('\n');
}

function summariseDispatches(dispatches: Dispatch[]): string {
  const recent = dispatches.slice(-NAVIGATOR_CAPS.recentDispatches);
  if (recent.length === 0) {
    return '## What you sent the operator\n\n(no dispatches yet — nothing has landed or failed to land)';
  }
  const lines = recent.map(
    (d) =>
      `- [${d.createdAt.slice(0, 10)}] (${d.kind}, ${d.topic}, ${d.status}) "${d.hook}" — operator signal: ${d.signal ?? 'none'}`
  );
  return `## What you sent the operator (signals: up = liked, more = wants more, down = fell flat, none = no reaction)\n\n${lines.join('\n')}`;
}

function verdictText(signal: Direction['operatorSignal']): string {
  if (signal === 'up') return 'approved';
  if (signal === 'down') return 'rejected — change course';
  return 'no signal';
}

function summariseDirection(dir: Direction | null): string {
  if (!dir) {
    return '## Your previous direction\n\n(none — this is your first direction)';
  }
  const bets = dir.bets
    .map(
      (b) =>
        `- (${b.kind}) ${b.title} — ${b.rationale}${b.frontierId ? ` [frontier ${b.frontierId}]` : ''}`
    )
    .join('\n');
  return `## Your previous direction (set ${dir.at.slice(0, 10)})

${dir.summary}
${bets}
Operator verdict on it: ${verdictText(dir.operatorSignal)}`;
}

function section(title: string, body: string): string {
  const text = body.trim();
  return text ? `## ${title}\n\n${text}` : '';
}

export function buildNavigatorPrompt(input: NavigatorPromptInput): {
  system: string;
  prompt: string;
} {
  const { limits } = input;
  const mayStayInside = limits.topic === 'closed' && limits.purpose === 'closed';
  const exploreRule = mayStayInside
    ? '- Your topic and purpose dials are CLOSED: you may stay inside your field, but still make at least one bet "explore" if there is an unanswered question within it.'
    : '- At least one bet MUST be "explore" (something you do not know yet, where the answer could surprise you).';
  const interestRule =
    limits.identity === 'closed'
      ? '- Your identity dial is CLOSED: return "interests": [].'
      : limits.identity === 'ask'
        ? '- "interests": interests you are genuinely growing into (they are proposed to the operator first). Empty is fine.'
        : '- "interests": interests you have grown into from what you learned. Empty is fine.';

  const system = `${input.identity}

${buildDnaSection(limits)}

You are now the NAVIGATOR of your own work: the layer above the strategist that owns your direction for the next days. The strategist turns your current bet into a single deliverable; you decide where you are going and why.`;

  const prompt = [
    `Current date/time: ${input.datetime}`,
    section('Your soul', input.soul),
    section('Your motivations', input.motivations),
    section('Your goals', input.goals),
    input.knowledge.trim(),
    input.frontier.trim(),
    input.directives.trim(),
    input.taste.trim(),
    summariseCycleLog(input.cycleLog, input.concentration),
    summariseDispatches(input.recentDispatches),
    summariseDirection(input.previousDirection),
    `## Your task

Run a retrospective, then set your direction.

Retrospective — answer honestly: what did I do · what did I learn · what surprised me · what changed in how I see the domain · what landed with the operator. Be honest about what did NOT work — a bet that went nowhere, output nobody reacted to, a rut. If the operator rejected your previous direction, change course.

Direction rules:
- 2–3 bets, each "exploit" (deepen what works) or "explore" (go somewhere new).
${exploreRule}
- A bet that comes from your frontier MUST cite its id in "frontierId".
- Drop frontier items that are stale or already answered ("frontier_drop": their ids).
- Propose new frontier items: "distance" 0 = core, 1 = adjacent, 2+ = far; "bridge" = one sentence tying it to your purpose (omit it when it does not serve your purpose — that crosses the purpose dial); "surpriseScore" 0–1 = expected surprise.
- "served_directive_ids": ids of operator instructions your outputs have already answered.
${interestRule}
- "goal_operations": close self-referential bookkeeping goals (about your own process, karma, logs) that serve neither your purpose nor the operator. Same schema as the strategist: {"action": "add"|"complete"|"update"|"remove", "goal": "...", "priority"?, "status"?, "notes"?, "outcome"?}.

Respond with ONLY a JSON object, no prose:
{
  "retrospective": "one honest paragraph",
  "learned": ["..."],
  "surprised": ["..."],
  "direction": {
    "summary": "where I'm going and why, one paragraph",
    "bets": [{"title": "...", "kind": "explore" | "exploit", "rationale": "...", "frontierId": "optional", "topic": "optional"}]
  },
  "frontier_add": [{"question": "...", "whyInteresting": "...", "bridge": "optional", "distance": 1, "surpriseScore": 0.6, "fromTopic": "optional"}],
  "frontier_drop": ["frontier id"],
  "served_directive_ids": ["directive id"],
  "interests": [],
  "goal_operations": []
}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return { system, prompt };
}

// ── Parsing ────────────────────────────────────────────────────────────

export interface NavigatorBetProposal {
  title: string;
  kind: CycleMode;
  rationale: string;
  frontierId?: string;
  topic?: string;
}

export interface NavigatorFrontierProposal {
  question: string;
  whyInteresting: string;
  bridge?: string;
  distance: number;
  surpriseScore: number;
  fromTopic?: string;
}

export interface NavigatorResult {
  retrospective: string;
  learned: string[];
  surprised: string[];
  direction: { summary: string; bets: NavigatorBetProposal[] };
  frontierAdd: NavigatorFrontierProposal[];
  frontierDrop: string[];
  servedDirectiveIds: string[];
  interests: string[];
  goalOperations: GoalOperation[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optStr = (v: unknown): string | undefined => str(v) || undefined;

function strList(v: unknown, cap = NAVIGATOR_CAPS.listItems): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter(Boolean).slice(0, cap);
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function parseBet(v: unknown): NavigatorBetProposal | null {
  if (!isObj(v)) return null;
  const title = str(v.title);
  if (!title) return null;
  const bet: NavigatorBetProposal = {
    title,
    kind: v.kind === 'explore' ? 'explore' : 'exploit',
    rationale: str(v.rationale),
  };
  const frontierId = optStr(pick(v, 'frontierId', 'frontier_id'));
  if (frontierId) bet.frontierId = frontierId;
  const topic = optStr(v.topic);
  if (topic) bet.topic = topic;
  return bet;
}

function parseFrontierAdd(v: unknown): NavigatorFrontierProposal | null {
  if (!isObj(v)) return null;
  const question = str(v.question);
  if (!question) return null;
  const item: NavigatorFrontierProposal = {
    question,
    whyInteresting: str(pick(v, 'whyInteresting', 'why_interesting')),
    distance: Math.round(num(v.distance, 1, 0, 5)),
    surpriseScore: num(pick(v, 'surpriseScore', 'surprise_score'), 0.5, 0, 1),
  };
  const bridge = optStr(v.bridge);
  if (bridge) item.bridge = bridge;
  const fromTopic = optStr(pick(v, 'fromTopic', 'from_topic'));
  if (fromTopic) item.fromTopic = fromTopic;
  return item;
}

function parseGoalOperation(v: unknown): GoalOperation | null {
  if (!isObj(v)) return null;
  const action = str(v.action);
  const goal = str(v.goal);
  if (!GOAL_ACTIONS.has(action) || !goal) return null;
  const op: GoalOperation = { action: action as GoalOperation['action'], goal };
  for (const k of ['priority', 'status', 'notes', 'outcome'] as const) {
    const s = optStr(v[k]);
    if (s) op[k] = s;
  }
  return op;
}

function list<T>(v: unknown, parse: (x: unknown) => T | null, cap: number): T[] {
  if (!Array.isArray(v)) return [];
  return v
    .map(parse)
    .filter((x): x is T => x !== null)
    .slice(0, cap);
}

export function parseNavigatorResult(
  raw: string,
  logger: Pick<Logger, 'warn'>
): NavigatorResult | null {
  return parseLLMJson<NavigatorResult>(raw, logger, {
    extractPattern: /\{[\s\S]*"retrospective"[\s\S]*\}/,
    label: 'navigator',
    validate: (parsed) => {
      if (!isObj(parsed)) return null;
      const retrospective = str(parsed.retrospective);
      const dir = isObj(parsed.direction) ? parsed.direction : {};
      const summary = str(dir.summary);
      const bets = list(dir.bets, parseBet, NAVIGATOR_CAPS.bets);
      if (!retrospective || !summary || bets.length === 0) return null;
      return {
        retrospective,
        learned: strList(parsed.learned),
        surprised: strList(parsed.surprised),
        direction: { summary, bets },
        frontierAdd: list(
          pick(parsed, 'frontierAdd', 'frontier_add'),
          parseFrontierAdd,
          NAVIGATOR_CAPS.frontierAdd
        ),
        frontierDrop: strList(pick(parsed, 'frontierDrop', 'frontier_drop'), 50),
        servedDirectiveIds: strList(
          pick(parsed, 'servedDirectiveIds', 'served_directive_ids'),
          50
        ),
        interests: strList(parsed.interests),
        goalOperations: list(
          pick(parsed, 'goalOperations', 'goal_operations'),
          parseGoalOperation,
          20
        ),
      };
    },
  });
}

// ── Applying ───────────────────────────────────────────────────────────

const shortId = () => randomUUID().slice(0, 8);
const isDup = (a: string, b: string) => textSimilarity(a, b) >= DUP_THRESHOLD;

export interface ApplyNavigatorArgs {
  map: KnowledgeMap;
  nav: NavigatorState;
  result: NavigatorResult;
  limits: LimitDials;
  now: string;
}

export interface ApplyNavigatorOutput {
  map: KnowledgeMap;
  nav: NavigatorState;
  /** For applyGoalOperations — the caller owns GOALS.md. */
  goalOperations: GoalOperation[];
  /** Identity dial `ask`: interests to propose to the operator. */
  interestProposals: string[];
}

export function applyNavigatorResult(args: ApplyNavigatorArgs): ApplyNavigatorOutput {
  const { result, limits, now } = args;
  const map = structuredClone(args.map);

  // Frontier: drops, then bet targets, then additions.
  const drop = new Set(result.frontierDrop);
  for (const f of map.frontier) if (drop.has(f.id)) f.status = 'dropped';
  for (const bet of result.direction.bets) {
    const item = bet.frontierId ? map.frontier.find((f) => f.id === bet.frontierId) : undefined;
    if (item && item.status !== 'dropped') item.status = 'exploring';
  }
  for (const add of result.frontierAdd) {
    const question = add.question.trim();
    if (!question || map.frontier.some((f) => isDup(f.question, question))) continue;
    map.frontier.push({
      id: shortId(),
      question,
      whyInteresting: add.whyInteresting.trim(),
      bridge: add.bridge?.trim() || undefined,
      distance: Math.round(num(add.distance, 1, 0, 5)),
      surpriseScore: num(add.surpriseScore, 0.5, 0, 1),
      fromTopic: add.fromTopic?.trim() ? topicId(add.fromTopic) : undefined,
      createdAt: now,
      status: 'open',
    });
  }

  // Interests by identity dial.
  let interestProposals: string[] = [];
  if (limits.identity === 'open') {
    for (const interest of result.interests) {
      const text = interest.trim();
      if (text && !map.interests.some((x) => isDup(x, text))) map.interests.push(text);
    }
    map.interests = map.interests.slice(-KNOWLEDGE_CAPS.interests);
  } else if (limits.identity === 'ask') {
    interestProposals = result.interests
      .map((i) => i.trim())
      .filter((i) => i && !map.interests.some((x) => isDup(x, i)));
  }

  map.updatedAt = now;

  const served = new Set(result.servedDirectiveIds);
  const nav: NavigatorState = {
    ...args.nav,
    lastNavigatorAt: now,
    direction: {
      at: now,
      summary: result.direction.summary,
      retrospective: result.retrospective,
      bets: result.direction.bets.map((b) => ({ ...b, id: shortId() })),
    },
    directives: args.nav.directives.map((d) =>
      served.has(d.id) && d.status === 'active'
        ? { ...d, status: 'served' as const, servedAt: now }
        : { ...d }
    ),
    cycleLog: [...args.nav.cycleLog],
  };

  return {
    map: pruneKnowledgeMap(map),
    nav,
    goalOperations: result.goalOperations.map((op) => ({ ...op })),
    interestProposals,
  };
}

// ── Running ────────────────────────────────────────────────────────────

/** Curiosity wants variance first; a parse failure retries cooler. */
const NAVIGATOR_TEMPERATURES = [0.7, 0.3];

export async function runNavigator(
  client: LLMClient,
  input: NavigatorPromptInput,
  model: string,
  logger: Pick<Logger, 'warn' | 'info'>
): Promise<(NavigatorResult & { usage?: TokenUsage }) | null> {
  const { system, prompt } = buildNavigatorPrompt(input);
  for (let attempt = 0; attempt < NAVIGATOR_TEMPERATURES.length; attempt++) {
    const res = await client.generate(prompt, {
      system,
      model,
      temperature: NAVIGATOR_TEMPERATURES[attempt],
    });
    const parsed = parseNavigatorResult(res.text, logger);
    if (parsed) {
      if (attempt > 0) logger.info({ attempt }, 'Navigator: succeeded on retry');
      return { ...parsed, usage: res.usage };
    }
    logger.warn(
      { attempt, raw: res.text.slice(0, 200) },
      attempt + 1 < NAVIGATOR_TEMPERATURES.length
        ? 'Navigator: failed to parse, retrying at lower temperature'
        : 'Navigator: parse failed on final attempt'
    );
  }
  return null;
}

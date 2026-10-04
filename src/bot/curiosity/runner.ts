/**
 * Curiosity cycle runner — the only thing the agent loop calls.
 *
 *   beginCuriosityCycle  (before strategist/planner)
 *     record operator directives → decay served ones → count ignored dispatches
 *     → run the navigator when due → decide explore/exploit → pick a frontier
 *     target → build the DNA block injected into strategist + planner
 *
 *   finishCuriosityCycle (after the executor)
 *     extract knowledge → merge the map → serve directives → log the cycle
 *     → at most one dispatch through the editor, cadence and fleet limit
 *
 * Both run under the bot's exclusive lock, re-read state after every LLM
 * await (operator signals and messages land meanwhile), and never throw.
 */
import type { LLMClient, TokenUsage } from '../../core/llm-client';
import type { Logger } from '../../logger';
import type { GoalOperation } from '../agent-strategist';
import {
  type CycleModeDecision,
  type FrontierProposal,
  type TopicConcentration,
  computeTopicConcentration,
  decideCycleMode,
  noteCycle,
  recordCycle,
  renderFrontierForPrompt,
  selectFrontierItem,
} from './cycle';
import {
  addDirective,
  decayDirectives,
  renderDirectivesForPrompt,
  serveDirectives,
} from './directives';
import {
  type DispatchCandidate,
  type EditorResult,
  applyHypePenalty,
  applyRevision,
  buildDigestCandidate,
  buildDispatch,
  decideDispatch,
  findHypeWords,
  isCadenceOpen,
  proposalCandidate,
  renderDispatchBody,
  runEditor,
} from './dispatch';
import { buildDnaSection } from './dna';
import { type ExtractedDispatch, runExtractor } from './extractor';
import { markFrontier, mergeExtraction, renderKnowledgeForPrompt, topicId } from './knowledge-map';
import type { DispatchDelivery } from './loop-wiring';
import { applyNavigatorResult, runNavigator, shouldRunNavigator } from './navigator';
import type { CuriosityService } from './service';
import type { CuriosityStore } from './store';
import { applyIgnored, likedTopicScores, renderTasteForPrompt } from './taste';
import type { CycleMode, Direction, Dispatch, FrontierItem, ResolvedCuriosity } from './types';

export type CuriosityCaller = 'curiosity:navigator' | 'curiosity:extractor' | 'curiosity:editor';

export interface CuriosityLLMCall {
  caller: CuriosityCaller;
  durationMs: number;
  success: boolean;
  usage?: TokenUsage;
  error?: string;
}

export interface RunnerDeps {
  service: CuriosityService;
  llm: { client: LLMClient; model: string };
  logger: Logger;
  /** Deliver a dispatch: 'telegram' pinged, 'inbox' dashboard only, false failed. */
  deliver: (botId: string, text: string) => Promise<DispatchDelivery>;
  /** Owner of GOALS.md (the strategist's applyGoalOperations, bound to the bot). */
  applyGoalOperations: (ops: GoalOperation[]) => void;
  /** Fleet-wide send limit; default allows. */
  fleetAllows?: (botId: string) => boolean;
  /** Called after a dispatch is delivered (fleet limiter bookkeeping). */
  onDelivered?: (botId: string) => void;
  /** Every curiosity LLM call, for the query log / metering. */
  onLLMCall?: (call: CuriosityLLMCall) => void;
  now?: () => string;
}

export interface CuriosityCycle {
  botId: string;
  cfg: ResolvedCuriosity;
  decision: CycleModeDecision;
  frontierItem: FrontierItem | null;
  proposals: FrontierProposal[];
  concentration: TopicConcentration;
  /** A background navigator run was started this cycle (it lands when it finishes). */
  navigatorStarted: boolean;
  /** DNA + direction + instructions + knowledge + frontier + taste. */
  curiosityBlock: string;
}

export interface BeginArgs {
  botId: string;
  identity: string;
  soul: string;
  motivations: string;
  goals: string;
  answered: Array<{ question: string; answer: string }>;
  feedback: string[];
  /** No human signal inside the engagement window. */
  operatorSilent?: boolean;
  /** The agent loop gave up waiting; stop before writing anything else. */
  isCancelled?: () => boolean;
}

/** Hard cap for the block injected into strategist + planner prompts. */
export const CURIOSITY_BLOCK_MAX_CHARS = 6000;

/** Wrap a client so every call is reported (caller, duration, usage, failure). */
function instrument(deps: RunnerDeps, caller: CuriosityCaller): LLMClient {
  const inner = deps.llm.client;
  if (!deps.onLLMCall) return inner;
  const report = deps.onLLMCall;
  return {
    ...inner,
    generate: async (prompt: string, opts: Parameters<LLMClient['generate']>[1]) => {
      const start = Date.now();
      try {
        const res = await inner.generate(prompt, opts);
        report({ caller, durationMs: Date.now() - start, success: true, usage: res.usage });
        return res;
      } catch (err) {
        report({
          caller,
          durationMs: Date.now() - start,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  } as LLMClient;
}

function renderDirection(direction: Direction | null): string {
  if (!direction) return '';
  const verdict =
    direction.operatorSignal === 'up'
      ? ' (operator liked this direction)'
      : direction.operatorSignal === 'down'
        ? ' (operator rejected this direction — change course)'
        : '';
  const bets = direction.bets.map((b) => `- [${b.kind}] ${b.title} — ${b.rationale}`).join('\n');
  return `## Your Current Direction (set ${direction.at.slice(0, 10)})${verdict}\n\n${direction.summary}\n${bets}`;
}

export async function beginCuriosityCycle(
  deps: RunnerDeps,
  args: BeginArgs
): Promise<CuriosityCycle | null> {
  return deps.service
    .runExclusive(args.botId, () => beginLocked(deps, args))
    .catch((err) => {
      deps.logger.warn({ err, botId: args.botId }, 'Curiosity: cycle preparation failed');
      return null;
    });
}

async function beginLocked(deps: RunnerDeps, args: BeginArgs): Promise<CuriosityCycle | null> {
  const now = deps.now?.() ?? new Date().toISOString();
  const log = deps.logger;
  const cancelled = () => args.isCancelled?.() === true;
  const cfg = deps.service.resolve(args.botId);
  const store = deps.service.storeFor(args.botId);
  if (!cfg?.enabled || !store) return null;

  // 1. Operator signals → directives; decay what has been served.
  let nav = store.loadNavigator();
  for (const a of args.answered) {
    nav = addDirective(nav, {
      text: `Q: ${a.question}\nA: ${a.answer}`,
      source: 'ask_human',
      receivedAt: now,
    });
  }
  for (const f of args.feedback) {
    nav = addDirective(nav, { text: f, source: 'feedback', receivedAt: now });
  }
  nav = decayDirectives(nav, cfg, now);
  store.saveNavigator(nav);

  // 2. Silence is a signal: unanswered Telegram dispatches lengthen the cadence.
  const ignored = applyIgnored(
    store.loadTaste(cfg.dispatch.baseIntervalHours),
    store.listDispatches(50),
    cfg.dispatch,
    now
  );
  if (ignored.counted.length > 0) {
    store.saveTaste(ignored.taste);
    for (const id of ignored.counted) store.updateDispatch(id, { ignoredCounted: true });
  }
  const taste = ignored.taste;

  // 3. Navigator when due — in the background. A retrospective on the Claude
  // CLI easily outlasts the cycle's time budget; it must never block the cycle
  // nor be thrown away when the cycle moves on. It lands whenever it finishes
  // and the next cycle reads it. The attempt is stamped first so failures back off.
  let navigatorStarted = false;
  if (shouldRunNavigator(nav, cfg, Date.parse(now))) {
    nav = { ...nav, lastNavigatorAttemptAt: now };
    store.saveNavigator(nav);
    const snapshot = nav;
    navigatorStarted = deps.service.startNavigator(args.botId, () =>
      runNavigatorInBackground(deps, args, store, cfg, snapshot, taste, now)
    );
  }
  if (cancelled()) return null;

  // 4. Explore or exploit, and what to explore.
  let map = store.loadMap();
  const decision = decideCycleMode(nav, cfg, { operatorSilent: args.operatorSilent });
  const concentration = computeTopicConcentration(nav.cycleLog, cfg.topicWindow);
  const selection = selectFrontierItem(map, cfg.limits, {
    avoidTopic: decision.mode === 'explore' ? concentration.dominantTopic : null,
    likedTopics: likedTopicScores(taste),
  });
  let frontierItem: FrontierItem | null = null;
  if (decision.mode === 'explore' && selection.item) {
    frontierItem = selection.item;
    map = markFrontier(map, frontierItem.id, 'exploring', now);
    store.saveMap(map);
  }

  return {
    botId: args.botId,
    cfg,
    decision,
    frontierItem,
    proposals: selection.proposals,
    concentration,
    navigatorStarted,
    curiosityBlock: buildCuriosityBlock(
      cfg,
      decision,
      frontierItem,
      concentration,
      nav,
      map,
      taste
    ),
  };
}

/** One navigator run; applies onto fresh state when the LLM returns. Never throws. */
async function runNavigatorInBackground(
  deps: RunnerDeps,
  args: BeginArgs,
  store: CuriosityStore,
  cfg: ResolvedCuriosity,
  nav: ReturnType<CuriosityStore['loadNavigator']>,
  taste: ReturnType<CuriosityStore['loadTaste']>,
  now: string
): Promise<void> {
  const log = deps.logger;
  try {
    const before = store.loadMap();
    const result = await runNavigator(
      instrument(deps, 'curiosity:navigator'),
      {
        identity: args.identity,
        soul: args.soul,
        motivations: args.motivations,
        goals: args.goals,
        knowledge: renderKnowledgeForPrompt(before),
        frontier: renderFrontierForPrompt(before, cfg.limits),
        directives: renderDirectivesForPrompt(nav),
        taste: renderTasteForPrompt(taste),
        recentDispatches: store.listDispatches(8),
        cycleLog: nav.cycleLog,
        concentration: computeTopicConcentration(nav.cycleLog, cfg.topicWindow),
        previousDirection: nav.direction,
        limits: cfg.limits,
        datetime: now,
      },
      deps.llm.model,
      log
    );
    if (!result) {
      log.warn({ botId: args.botId }, 'Curiosity: navigator returned nothing usable');
      return;
    }
    // Apply onto fresh state (synchronous from here: no interleaving).
    const applied = applyNavigatorResult({
      map: store.loadMap(),
      nav: store.loadNavigator(),
      result,
      limits: cfg.limits,
      now,
    });
    const pending = [...(applied.nav.pendingInterests ?? []), ...applied.interestProposals];
    store.saveMap(applied.map);
    store.saveNavigator({ ...applied.nav, pendingInterests: [...new Set(pending)].slice(-5) });
    if (applied.goalOperations.length > 0) {
      try {
        deps.applyGoalOperations(applied.goalOperations);
      } catch (err) {
        log.warn({ err, botId: args.botId }, 'Curiosity: navigator goal operations failed');
      }
    }
    log.info(
      { botId: args.botId, direction: result.direction.summary.slice(0, 160) },
      'Curiosity: navigator set a new direction'
    );
  } catch (err) {
    log.warn({ err, botId: args.botId }, 'Curiosity: navigator failed');
  }
}

/** The block every layer reads, capped: the knowledge map shrinks first. */
function buildCuriosityBlock(
  cfg: ResolvedCuriosity,
  decision: CycleModeDecision,
  frontierItem: FrontierItem | null,
  concentration: TopicConcentration,
  nav: ReturnType<CuriosityStore['loadNavigator']>,
  map: ReturnType<CuriosityStore['loadMap']>,
  taste: ReturnType<CuriosityStore['loadTaste']>
): string {
  const head = [
    buildDnaSection(
      cfg.limits,
      decision.mode === 'explore'
        ? {
            mode: 'explore',
            reason: decision.reason,
            frontierQuestion: frontierItem?.question,
            frontierWhy: frontierItem?.whyInteresting,
            dominantTopic: concentration.dominantTopic,
          }
        : undefined
    ),
    renderDirection(nav.direction),
    renderDirectivesForPrompt(nav, 1500),
  ];
  const tail = [renderFrontierForPrompt(map, cfg.limits, 6), renderTasteForPrompt(taste)];
  const fixed = [...head, ...tail].filter(Boolean).join('\n\n').length;
  const knowledgeBudget = Math.max(600, Math.min(2500, CURIOSITY_BLOCK_MAX_CHARS - fixed - 4));
  const block = [...head, renderKnowledgeForPrompt(map, knowledgeBudget), ...tail]
    .filter(Boolean)
    .join('\n\n');
  return block.length > CURIOSITY_BLOCK_MAX_CHARS
    ? `${block.slice(0, CURIOSITY_BLOCK_MAX_CHARS - 1)}…`
    : block;
}

export interface FinishArgs {
  botId: string;
  botName: string;
  emoji?: string;
  identity: string;
  cycle: CuriosityCycle;
  deliverable?: string;
  plan: string[];
  summary: string;
  toolCalls: Array<{ name: string; args?: Record<string, unknown>; success?: boolean }>;
  idle?: boolean;
}

export interface FinishResult {
  extracted: boolean;
  dispatch?: Dispatch;
}

const WRITE_TOOLS = new Set(['file_write', 'file_edit']);

export async function finishCuriosityCycle(
  deps: RunnerDeps,
  args: FinishArgs
): Promise<FinishResult> {
  return deps.service
    .runExclusive(args.botId, () => finishLocked(deps, args))
    .catch((err) => {
      deps.logger.warn({ err, botId: args.botId }, 'Curiosity: cycle wrap-up failed');
      return { extracted: false };
    });
}

/** A cycle with nothing to learn from still moves the explore cadence. */
function noteOnly(store: CuriosityStore, mode: CycleMode): FinishResult {
  store.saveNavigator(noteCycle(store.loadNavigator(), mode));
  return { extracted: false };
}

async function finishLocked(deps: RunnerDeps, args: FinishArgs): Promise<FinishResult> {
  const now = deps.now?.() ?? new Date().toISOString();
  const { cycle } = args;
  const store = deps.service.storeFor(args.botId);
  if (!store) return { extracted: false };
  if (args.idle) return noteOnly(store, cycle.decision.mode);

  const known = store.loadMap();
  const extracted = await runExtractor(
    instrument(deps, 'curiosity:extractor'),
    deps.llm.model,
    {
      identity: args.identity,
      deliverable: args.deliverable,
      plan: args.plan,
      summary: args.summary,
      toolCalls: args.toolCalls,
      mode: cycle.decision.mode,
      frontierQuestion: cycle.frontierItem?.question,
      knownTopics: known.topics.map((t) => t.name),
      directives: renderDirectivesForPrompt(store.loadNavigator()),
      limits: cycle.cfg.limits,
    },
    deps.logger
  ).catch(() => null);
  if (!extracted) {
    deps.logger.warn({ botId: args.botId }, 'Curiosity: extractor returned nothing usable');
    return noteOnly(store, cycle.decision.mode);
  }

  const outputs = args.toolCalls
    .filter((t) => WRITE_TOOLS.has(t.name) && t.success !== false)
    .map((t) => String(t.args?.path ?? t.args?.relativePath ?? ''))
    .filter(Boolean);
  const extraction = {
    ...extracted.extraction,
    outputs: [...(extracted.extraction.outputs ?? []), ...outputs],
    interests: cycle.cfg.limits.identity === 'open' ? extracted.extraction.interests : [],
  };

  // Fresh state after the await.
  let map = mergeExtraction(store.loadMap(), extraction, now);
  if (cycle.frontierItem) map = markFrontier(map, cycle.frontierItem.id, 'explored', now);
  store.saveMap(map);

  let nav = serveDirectives(store.loadNavigator(), extraction.servedDirectiveIds, now);
  nav = recordCycle(nav, {
    at: now,
    topic: topicId(extraction.topic),
    mode: cycle.decision.mode,
    surprised: !extraction.noSurprise,
    frontierId: cycle.frontierItem?.id,
  });
  store.saveNavigator(nav);

  const dispatch = await maybeDispatch(
    deps,
    args,
    store,
    extracted.dispatch,
    extraction.topic,
    now
  );
  return { extracted: true, dispatch };
}

/** Score for an insight held without an editor pass (cadence closed). */
function heldScore(c: DispatchCandidate): number {
  return Math.max(0, 0.5 - 0.1 * findHypeWords(`${c.hook} ${c.whyCare}`).length);
}

/** At most one dispatch per cycle: insight → interest proposal → frontier proposal → digest. */
async function maybeDispatch(
  deps: RunnerDeps,
  args: FinishArgs,
  store: CuriosityStore,
  insight: ExtractedDispatch | null,
  topic: string,
  now: string
): Promise<Dispatch | undefined> {
  const { cfg } = args.cycle;
  if (!cfg.dispatch.enabled) return undefined;
  const nowMs = Date.parse(now);
  const cadenceOpen = isCadenceOpen(store.loadTaste(cfg.dispatch.baseIntervalHours).cadence, nowMs);
  const recent = store.listDispatches(100);

  let candidate: DispatchCandidate | null = null;
  let interest: string | undefined;
  if (insight) {
    candidate = { kind: 'insight', topic, ...insight };
  }
  if (!candidate && cadenceOpen) {
    const proposed = new Set(recent.map((d) => d.interest).filter(Boolean));
    interest = (store.loadNavigator().pendingInterests ?? []).find((i) => !proposed.has(i));
    if (interest) {
      candidate = {
        kind: 'proposal',
        topic: 'identity',
        hook: `I think I am growing into a new interest: ${interest}`,
        whyCare: 'It keeps showing up in what I learn, and it may sharpen what I bring you.',
        evidence: 'Recurring in my recent findings.',
        action: 'Approve and I will treat it as part of who I am.',
        crossing: ['identity'],
      };
    }
  }
  if (!candidate && cadenceOpen) {
    const sent = new Set(recent.map((d) => d.frontierId).filter(Boolean));
    const fresh = args.cycle.proposals.find((p) => !sent.has(p.item.id));
    if (fresh) candidate = proposalCandidate(fresh);
  }
  if (!candidate && cadenceOpen) {
    const windowMs = cfg.dispatch.maxIntervalHours * 3_600_000;
    const lastSent = recent.find((d) => d.status === 'sent');
    const lastDigest = recent.find((d) => d.kind === 'digest');
    const quiet = !lastSent?.sentAt || nowMs - Date.parse(lastSent.sentAt) >= windowMs;
    const digestDue = !lastDigest || nowMs - Date.parse(lastDigest.createdAt) >= windowMs;
    if (quiet && digestDue) {
      candidate = buildDigestCandidate(recent.filter((d) => d.status === 'held'));
    }
  }
  if (!candidate) return undefined;

  // Cadence closed: hold the insight for the next digest without spending an editor call.
  if (!cadenceOpen) {
    const body = renderDispatchBody(candidate, {
      botName: args.botName,
      emoji: args.emoji,
      maxChars: cfg.dispatch.maxChars,
    });
    const held = {
      ...buildDispatch({ botId: args.botId, candidate, body, editor: null, status: 'held', now }),
      editorScore: heldScore(candidate),
      editorNotes: 'held: cadence closed, not edited',
    };
    store.appendDispatch(held);
    return held;
  }

  let editor: EditorResult | null = await runEditor(
    instrument(deps, 'curiosity:editor'),
    deps.llm.model,
    {
      candidate,
      knowledge: renderKnowledgeForPrompt(store.loadMap(), 2000),
      taste: renderTasteForPrompt(store.loadTaste(cfg.dispatch.baseIntervalHours)),
      identity: args.identity,
      maxChars: cfg.dispatch.maxChars,
    },
    deps.logger
  ).catch(() => null);
  const revised = applyRevision(candidate, editor?.revised);
  const body = renderDispatchBody(revised, {
    botName: args.botName,
    emoji: args.emoji,
    maxChars: cfg.dispatch.maxChars,
  });
  if (editor) editor = applyHypePenalty(editor, body);

  let status = decideDispatch({ kind: revised.kind, editor, cadenceOpen, settings: cfg.dispatch });
  if (status === 'sent' && deps.fleetAllows && !deps.fleetAllows(args.botId)) status = 'held';
  let deliveredVia: DispatchDelivery = false;
  if (status === 'sent') {
    deliveredVia = await deps.deliver(args.botId, body).catch(() => false as const);
    if (deliveredVia) deps.onDelivered?.(args.botId);
    else status = 'held';
  }

  const dispatch: Dispatch = {
    ...buildDispatch({ botId: args.botId, candidate: revised, body, editor, status, now }),
    ...(interest ? { interest } : {}),
    ...(deliveredVia ? { deliveredVia } : {}),
  };
  store.appendDispatch(dispatch);
  if (interest) {
    const n = store.loadNavigator();
    store.saveNavigator({
      ...n,
      pendingInterests: (n.pendingInterests ?? []).filter((i) => i !== interest),
    });
  }
  if (status === 'sent') {
    // Fresh taste: a signal may have changed the interval while we waited.
    const fresh = store.loadTaste(cfg.dispatch.baseIntervalHours);
    store.saveTaste({ ...fresh, cadence: { ...fresh.cadence, lastSentAt: now } });
    // A digest consumes the held items it summarised.
    if (revised.kind === 'digest') {
      for (const d of store.listDispatches(100).filter((x) => x.status === 'held')) {
        store.updateDispatch(d.id, { status: 'dropped' });
      }
    }
  }
  deps.logger.info(
    { botId: args.botId, kind: revised.kind, status, deliveredVia, score: editor?.score },
    'Curiosity: dispatch decided'
  );
  return dispatch;
}

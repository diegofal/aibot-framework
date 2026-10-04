/**
 * Curiosity DNA — the dispatch (plan §5, "Captivating" + "Honest" genes).
 *
 * A dispatch is what the operator actually receives: one non-obvious claim
 * up front, why it matters to them, the evidence, what to do, and at most
 * one question. Before anything is sent a separate editor pass scores it
 * (insight, novelty against the knowledge map, backing) and a deterministic
 * hype detector docks points. Below the bar it is held for a digest.
 *
 * Anti-goals: no hype, no cliffhangers, no withholding to drive opens, no
 * unbacked superlatives. Everything here is pure except `runEditor`.
 */

import { randomUUID } from 'node:crypto';
import type { LLMClient, TokenUsage } from '../../core/llm-client';
import type { Logger } from '../../logger';
import { parseLLMJson } from '../llm-json-parser';
import type { FrontierProposal } from './cycle';
import type {
  Dispatch,
  DispatchCadence,
  DispatchKind,
  DispatchSettings,
  DispatchStatus,
  LimitDial,
} from './types';

export interface DispatchCandidate {
  kind: DispatchKind;
  topic: string;
  hook: string;
  whyCare: string;
  evidence: string;
  action: string;
  question?: string;
  crossing?: LimitDial[];
  frontierId?: string;
}

// ── Hype detector ───────────────────────────────────────────────────────

export interface HypePattern {
  /** Canonical (English) label reported for a hit, whatever the language. */
  label: string;
  pattern: RegExp;
}

export const HYPE_PATTERNS: readonly HypePattern[] = [
  {
    label: 'game-changer',
    pattern: /\bgame[- ]?chang(?:er|ers|ing)\b|\bcambia(?:r[áa])? (?:el|las reglas del) juego\b/i,
  },
  { label: 'revolutionary', pattern: /\brevolutionary\b|\brevolucionari[oa]s?\b/i },
  {
    label: 'mind-blowing',
    pattern: /\bmind[- ]?blow(?:ing|n)\b|\balucinante\b|\bte (?:va a )?vuela la cabeza\b/i,
  },
  {
    label: "you won't believe",
    pattern:
      /\byou won['’]?t believe\b|\bno (?:lo )?(?:vas a|van a|podr[áa]s) creer\b|\bno creer[áa]s\b/i,
  },
  {
    label: 'cliffhanger',
    pattern:
      /\byou['’]?ll never guess\b|\bwait (?:until|till) you see\b|\bnunca adivinar[áa]s\b|\bespera a ver\b/i,
  },
  { label: 'insane', pattern: /\binsane(?:ly)?\b|\buna locura\b/i },
  {
    label: 'groundbreaking',
    pattern: /\bground[- ]?breaking\b|\bunprecedented\b|\brompedor(?:a|es)?\b|\bsin precedentes\b/i,
  },
  { label: 'must-see', pattern: /\bmust[- ]?(?:see|read|watch)\b|\bimperdibles?\b/i },
  {
    label: 'unbelievable',
    pattern: /\bunbelievabl[ey]\b|\bjaw[- ]?dropping\b|\bincre[íi]bles?\b/i,
  },
  { label: 'emoji spam', pattern: /(?:(?:🚀|🔥|💥|🤯|‼️)[\s\S]*){2}/u },
  { label: 'exclamation spam', pattern: /!{2,}|¡{2,}/ },
  // Case-sensitive on purpose: two or more ALL-CAPS words in a row. A lone acronym is fine.
  { label: 'all-caps shouting', pattern: /(?<!\p{L})\p{Lu}{3,}(?:\s+\p{Lu}{3,})+(?!\p{L})/u },
];

/** Distinct hype labels found in `text` (one entry per pattern). */
export function findHypeWords(text: string): string[] {
  if (!text) return [];
  return HYPE_PATTERNS.filter((h) => h.pattern.test(text)).map((h) => h.label);
}

// ── Rendering ───────────────────────────────────────────────────────────

/** Plain-words reading of each limit dial, used in proposal footers. */
const DIAL_WORDS: Record<LimitDial, string> = {
  topic: 'studying outside my field',
  purpose: 'a side quest beyond my job',
  instructions: 'challenging your direction',
  method: 'a new kind of output',
  capability: 'new skills or access',
  identity: 'letting my interests drift',
};

const APPROVE_FOOTER = '👍 to approve, 👎 to decline';
/** A truncated field shorter than this is dropped instead (a stub reads worse than nothing). */
const MIN_FIELD_CHARS = 12;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 1) return '…'.slice(0, Math.max(0, n));
  return `${s.slice(0, n - 1).trimEnd()}…`;
}

interface RenderState {
  evidence: string;
  whyCare: string;
  action: string;
  question: string;
  footer: boolean;
}

export function renderDispatchBody(
  c: DispatchCandidate,
  opts: { botName: string; emoji?: string; maxChars: number }
): string {
  const prefix = `${opts.emoji ? `${opts.emoji} ` : ''}${opts.botName}: `;
  const header = `${prefix}${c.hook}`;
  const isDigest = c.kind === 'digest';
  const isProposal = c.kind === 'proposal';
  const crossingLine =
    isProposal && c.crossing && c.crossing.length > 0
      ? `This crosses my limits: ${c.crossing.map((d) => DIAL_WORDS[d] ?? d).join(', ')}.`
      : '';

  const render = (s: RenderState): string => {
    const parts = [header];
    if (isDigest) {
      if (s.evidence) parts.push(s.evidence);
    } else {
      if (s.whyCare) parts.push(`Why it matters to you: ${s.whyCare}`);
      if (s.evidence) parts.push(`Evidence: ${s.evidence}`);
    }
    if (s.action) parts.push(`What to do: ${s.action}`);
    if (isProposal && s.footer) {
      parts.push(crossingLine ? `${crossingLine}\n${APPROVE_FOOTER}` : APPROVE_FOOTER);
    }
    if (s.question) parts.push(s.question);
    return parts.join('\n\n');
  };

  const state: RenderState = {
    evidence: c.evidence?.trim() ?? '',
    whyCare: isDigest ? '' : (c.whyCare?.trim() ?? ''),
    action: c.action?.trim() ?? '',
    question: c.question?.trim() ?? '',
    footer: true,
  };

  let body = render(state);
  const max = opts.maxChars;
  if (body.length <= max) return body;

  // Truncation order: evidence → whyCare → action.
  for (const field of ['evidence', 'whyCare', 'action'] as const) {
    const over = body.length - max;
    if (over <= 0) break;
    const value = state[field];
    if (!value) continue;
    const keep = value.length - over;
    state[field] = keep >= MIN_FIELD_CHARS ? truncate(value, keep) : '';
    body = render(state);
  }
  if (body.length <= max) return body;

  // Then the question, then the proposal footer.
  state.question = '';
  body = render(state);
  if (body.length <= max) return body;
  state.footer = false;
  body = render(state);
  if (body.length <= max) return body;

  // Only the hook is left and it alone exceeds the budget.
  if (prefix.length >= max) return truncate(header, max);
  return `${prefix}${truncate(c.hook, max - prefix.length)}`;
}

// ── Editor ──────────────────────────────────────────────────────────────

export interface EditorInput {
  candidate: DispatchCandidate;
  /** Rendered knowledge map (renderKnowledgeForPrompt). */
  knowledge: string;
  /** Rendered taste profile (renderTasteForPrompt) — includes liked/disliked hooks. */
  taste: string;
  /** Bot identity / purpose summary. */
  identity: string;
  maxChars: number;
}

export interface EditorResult {
  insight: number;
  novelty: number;
  backed: number;
  score: number;
  verdict: 'send' | 'hold' | 'drop';
  notes: string;
  revised?: Partial<
    Pick<DispatchCandidate, 'hook' | 'whyCare' | 'evidence' | 'action' | 'question'>
  >;
}

export function buildEditorPrompt(input: EditorInput): { system: string; prompt: string } {
  const system = `You are a tough editor deciding whether a short message from an AI agent deserves its operator's attention. The operator is busy. Most drafts should NOT be sent.

Score three things, each from 0 to 1:
- "insight": is the hook non-obvious? Would the operator stop scrolling for it? A restated fact, a status update or a generic tip scores below 0.4.
- "novelty": is it new relative to what the agent already knows (the knowledge map) and to hooks the operator liked or disliked before? A near-duplicate of a known finding or of a disliked hook scores low.
- "backed": is every claim supported by the evidence given or by the knowledge map? Any unsupported claim, invented number or unbacked superlative scores below 0.5.

Rules for the message (penalise violations, and fix them in "revised"):
- No hype words (game-changer, revolutionary, mind-blowing, insane, groundbreaking, must-see and similar, in any language). No ALL-CAPS, no emoji spam, no "!!".
- No cliffhangers or teasers. Never withhold the point to make the operator open or reply; the hook states the finding itself.
- No unbacked superlatives ("the best", "the biggest", "always", "never") unless the evidence shows it.
- Calibrated language: say how sure the agent is when it matters.
- The hook is one sentence. The whole message must fit in the character cap.

"verdict": "send" if it is worth the operator's attention now, "hold" if it is true and mildly useful but not worth an interruption (it goes to a digest), "drop" if it is unbacked, wrong, a duplicate or empty.

You may return "revised" with tightened wording for any of: hook, whyCare, evidence, action, question. Revisions must not add claims that are not in the draft or the knowledge map. Omit "revised" if the draft is already tight.

Respond with JSON only:
{"insight": 0.0, "novelty": 0.0, "backed": 0.0, "verdict": "send" | "hold" | "drop", "notes": "one or two sentences on why", "revised": {"hook": "..."}}`;

  const c = input.candidate;
  const draft = [
    `kind: ${c.kind}`,
    `topic: ${c.topic}`,
    `hook: ${c.hook}`,
    `whyCare: ${c.whyCare}`,
    `evidence: ${c.evidence}`,
    `action: ${c.action}`,
    c.question ? `question: ${c.question}` : null,
    c.crossing?.length ? `crossing limits: ${c.crossing.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const section = (title: string, body: string) =>
    `## ${title}\n${body?.trim() ? body.trim() : '(empty)'}`;

  const prompt = [
    section('Agent identity', input.identity),
    section('Knowledge map (what the agent already knows)', input.knowledge),
    section("Operator's taste (what landed and what didn't)", input.taste),
    section('Draft dispatch', draft),
    `Character cap for the rendered message: ${input.maxChars}.`,
    'Edit it. JSON only.',
  ].join('\n\n');

  return { system, prompt };
}

const REVISABLE = ['hook', 'whyCare', 'evidence', 'action', 'question'] as const;

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function parseEditorResult(raw: string, logger: Pick<Logger, 'warn'>): EditorResult | null {
  return parseLLMJson<EditorResult>(raw, logger, {
    label: 'curiosity editor',
    extractPattern: /\{[\s\S]*\}/,
    validate: (p: any) => {
      if (!p || typeof p !== 'object') return null;
      const insight = num(p.insight ?? p.insight_score);
      const novelty = num(p.novelty ?? p.novelty_score);
      const backed = num(p.backed ?? p.backed_score);
      if (insight === null || novelty === null || backed === null) return null;

      const i = clamp01(insight);
      const n = clamp01(novelty);
      const b = clamp01(backed);
      const score = round3(0.5 * i + 0.3 * n + 0.2 * b);

      let verdict: EditorResult['verdict'] =
        p.verdict === 'send' || p.verdict === 'hold' || p.verdict === 'drop' ? p.verdict : 'hold';
      if (b < 0.5) verdict = 'drop';

      const result: EditorResult = {
        insight: i,
        novelty: n,
        backed: b,
        score,
        verdict,
        notes: typeof p.notes === 'string' ? p.notes : '',
      };

      if (p.revised && typeof p.revised === 'object') {
        const revised: EditorResult['revised'] = {};
        for (const key of REVISABLE) {
          const snake = key === 'whyCare' ? 'why_care' : key;
          const v = p.revised[key] ?? p.revised[snake];
          if (typeof v === 'string' && v.trim()) revised[key] = v.trim();
        }
        if (Object.keys(revised).length > 0) result.revised = revised;
      }
      return result;
    },
  });
}

/** Dock 0.1 from the score per distinct hype hit in `text` (floor 0). */
export function applyHypePenalty(result: EditorResult, text: string): EditorResult {
  const hits = findHypeWords(text);
  if (hits.length === 0) return result;
  const note = `hype: ${hits.join(', ')}`;
  return {
    ...result,
    score: round3(Math.max(0, result.score - 0.1 * hits.length)),
    notes: result.notes ? `${result.notes} | ${note}` : note,
  };
}

/**
 * Run the editor pass: temperature 0.2, one retry at 0 on a parse failure.
 * Returns null when the LLM fails or never yields parseable JSON — the
 * caller then holds the dispatch. The hype penalty is NOT applied here;
 * apply it to the final rendered body with `applyHypePenalty`.
 */
export async function runEditor(
  client: LLMClient,
  model: string,
  input: EditorInput,
  logger: Logger
): Promise<(EditorResult & { usage?: TokenUsage }) | null> {
  const { system, prompt } = buildEditorPrompt(input);
  const temperatures = [0.2, 0];
  for (let attempt = 0; attempt < temperatures.length; attempt++) {
    let text: string;
    let usage: TokenUsage | undefined;
    try {
      const res = await client.generate(prompt, {
        system,
        model,
        temperature: temperatures[attempt],
      });
      text = res.text;
      usage = res.usage;
    } catch (err) {
      logger.warn({ err, attempt }, 'Curiosity: editor LLM call failed');
      return null;
    }
    const parsed = parseEditorResult(text, logger);
    if (parsed) return usage ? { ...parsed, usage } : parsed;
    if (attempt < temperatures.length - 1) {
      logger.warn({ attempt }, 'Curiosity: editor output unparseable, retrying at temperature 0');
    }
  }
  return null;
}

// ── Cadence + decision ──────────────────────────────────────────────────

export function isCadenceOpen(cadence: DispatchCadence, nowMs: number): boolean {
  if (!cadence.lastSentAt) return true;
  const last = Date.parse(cadence.lastSentAt);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= cadence.intervalHours * 3_600_000;
}

/** Score a proposal or digest needs (they are already filtered: frontier gate / held items). */
const PROPOSAL_MIN_SCORE = 0.5;

export function decideDispatch(args: {
  kind: DispatchKind;
  editor: EditorResult | null;
  cadenceOpen: boolean;
  settings: DispatchSettings;
}): DispatchStatus {
  const { kind, editor, cadenceOpen, settings } = args;
  if (!settings.enabled) return 'held';
  if (!editor) return 'held';
  if (editor.verdict === 'drop') return 'dropped';
  if (!cadenceOpen) return 'held';
  if (kind === 'proposal' || kind === 'digest') {
    return editor.score >= PROPOSAL_MIN_SCORE ? 'sent' : 'held';
  }
  return editor.verdict === 'send' && editor.score >= settings.minEditorScore ? 'sent' : 'held';
}

// ── Builders ────────────────────────────────────────────────────────────

export function applyRevision(
  c: DispatchCandidate,
  revised: EditorResult['revised'] | undefined
): DispatchCandidate {
  if (!revised) return { ...c };
  const out: DispatchCandidate = { ...c };
  for (const key of REVISABLE) {
    const v = revised[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  return out;
}

export function buildDispatch(args: {
  botId: string;
  candidate: DispatchCandidate;
  body: string;
  editor: EditorResult | null;
  status: DispatchStatus;
  now: string;
}): Dispatch {
  const { botId, candidate: c, body, editor, status, now } = args;
  const d: Dispatch = {
    id: randomUUID().slice(0, 8),
    botId,
    createdAt: now,
    kind: c.kind,
    topic: c.topic,
    hook: c.hook,
    whyCare: c.whyCare,
    evidence: c.evidence,
    action: c.action,
    body,
    editorScore: editor?.score ?? 0,
    status,
  };
  if (c.question) d.question = c.question;
  if (editor?.notes) d.editorNotes = editor.notes;
  if (status === 'sent') d.sentAt = now;
  if (c.crossing?.length) d.crossing = [...c.crossing];
  if (c.frontierId) d.frontierId = c.frontierId;
  return d;
}

export function buildDigestCandidate(held: Dispatch[], max = 3): DispatchCandidate | null {
  const pool = held.filter((d) => d.status === 'held' && d.kind !== 'digest');
  if (pool.length === 0) return null;
  const top = [...pool].sort((a, b) => b.editorScore - a.editorScore).slice(0, Math.max(1, max));
  const total = pool.length;
  const noun = total === 1 ? 'smaller finding' : 'smaller findings';
  const hook =
    total > top.length
      ? `${total} ${noun} since my last message; the ${top.length} strongest are below.`
      : `${total} ${noun} since my last message.`;
  return {
    kind: 'digest',
    topic: 'digest',
    hook,
    whyCare: 'None cleared the bar on its own; together they show where I have been digging.',
    evidence: top.map((d, i) => `${i + 1}. ${d.hook}`).join('\n'),
    action: 'Each one is in the Dispatches feed; 👍 the ones you want me to take further.',
  };
}

export function proposalCandidate(p: FrontierProposal): DispatchCandidate {
  const { item } = p;
  return {
    kind: 'proposal',
    topic: item.fromTopic ?? 'frontier',
    hook: item.question,
    whyCare: item.whyInteresting,
    evidence: item.bridge
      ? `Link to my purpose: ${item.bridge}`
      : 'It does not serve my current purpose directly, which is why I ask first.',
    action: 'If you approve, I will explore it next and report back what I find.',
    crossing: [...p.crossing],
    frontierId: item.id,
  };
}

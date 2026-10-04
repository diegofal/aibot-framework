/**
 * Post-cycle extractor — one small LLM call after the executor that turns a
 * cycle into knowledge: topic, findings, surprises, open questions, frontier
 * candidates, served directives and (optionally) a dispatch candidate. This
 * is where the CURIOUS and COMPOUNDING genes become data.
 */
import type { LLMClient, TokenUsage } from '../../core/llm-client';
import type { Logger } from '../../logger';
import { parseLLMJson } from '../llm-json-parser';
import type { CycleExtraction } from './knowledge-map';
import type { Confidence, CycleMode, LimitDials } from './types';

export interface ExtractorInput {
  identity: string;
  deliverable?: string;
  plan: string[];
  summary: string;
  toolCalls: Array<{ name: string; args?: Record<string, unknown>; success?: boolean }>;
  mode: CycleMode;
  frontierQuestion?: string;
  knownTopics: string[];
  /** Rendered `renderDirectivesForPrompt` block ('' when none). */
  directives: string;
  limits: LimitDials;
}

/** Raw dispatch fields as the extractor proposes them (editor decides later). */
export interface ExtractedDispatch {
  hook: string;
  whyCare: string;
  evidence: string;
  action: string;
  question?: string;
}

export interface ExtractorResult {
  extraction: CycleExtraction;
  dispatch: ExtractedDispatch | null;
}

const SUMMARY_BUDGET = 5000;

function describeToolCalls(calls: ExtractorInput['toolCalls']): string {
  if (calls.length === 0) return '(no tool calls)';
  return calls
    .slice(0, 25)
    .map((c) => {
      const target = c.args?.path ?? c.args?.url ?? c.args?.query ?? c.args?.relativePath;
      return `- ${c.name}${target ? ` ${String(target).slice(0, 120)}` : ''}${c.success === false ? ' (failed)' : ''}`;
    })
    .join('\n');
}

export function buildExtractorPrompt(input: ExtractorInput): { system: string; prompt: string } {
  const explore =
    input.mode === 'explore'
      ? `\nThis was an exploration cycle${input.frontierQuestion ? ` aimed at: "${input.frontierQuestion}"` : ''}. Learning is the output — be generous with open questions, honest about confidence.`
      : '';
  const system = `You distill one work cycle of an autonomous agent into durable knowledge. You are its memory and its curiosity.

Agent: ${input.identity.slice(0, 600)}${explore}

Known topics so far: ${input.knownTopics.length > 0 ? input.knownTopics.join('; ') : '(none yet)'}
Reuse a known topic name when the cycle was about it; name a new topic only when it genuinely is one.

${input.directives || '(no operator instructions on record)'}

Answer, honestly and specifically:
1. What did the agent LEARN? Findings must be claims backed by something it actually did or read this cycle (cite the file/URL/result as evidence). Bookkeeping about its own logs or process is NOT a finding.
2. What did you NOT expect? Surprises are things that contradicted the agent's prior view. If nothing surprised it, say so (no_surprise: true) — that is a useful signal, do not invent one.
3. What is now an open question? What did this cycle answer?
4. Frontier: 0–3 questions worth chasing next, each with why the answer could surprise, a one-sentence bridge to the agent's purpose (omit if there is none), distance (0 same topic, 1 adjacent, 2+ far), surprise_score 0–1.
5. Which operator instruction ids (in brackets above) did this cycle's output answer?
6. Dispatch: ONLY if this cycle produced something the operator would stop scrolling for — one non-obvious, backed claim — propose it: hook (the claim, one sentence), why_care (tied to the operator's work), evidence, action. Otherwise "dispatch": null. No hype, no superlatives, no cliffhangers.
${input.limits.identity !== 'closed' ? '7. interests: subjects the agent seems to be growing into (may be empty).\n' : ''}
Respond with ONLY a JSON object:
{"topic": string, "findings": [{"claim": string, "evidence": string, "confidence": "low"|"medium"|"high"}], "surprises": [string], "open_questions": [string], "answered_questions": [string], "frontier": [{"question": string, "why_interesting": string, "bridge": string?, "distance": number, "surprise_score": number}], "served_directive_ids": [string], "no_surprise": boolean, "interests": [string], "dispatch": {"hook": string, "why_care": string, "evidence": string, "action": string, "question": string?} | null}`;

  const summary =
    input.summary.length > SUMMARY_BUDGET
      ? `${input.summary.slice(0, SUMMARY_BUDGET)}\n…(truncated)`
      : input.summary;
  const prompt = `## Assigned deliverable
${input.deliverable ?? '(none)'}

## Plan
${input.plan.map((p, i) => `${i + 1}. ${p}`).join('\n') || '(none)'}

## Tool calls
${describeToolCalls(input.toolCalls)}

## Executor's final report
${summary || '(empty)'}

Distill it. JSON only.`;
  return { system, prompt };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strList = (v: unknown, max = 10): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, max)
    : [];
const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const CONFIDENCES: Confidence[] = ['low', 'medium', 'high'];

export function parseExtractorResult(
  raw: string,
  logger: Pick<Logger, 'warn'>
): ExtractorResult | null {
  return parseLLMJson<ExtractorResult>(raw, logger, {
    extractPattern: /\{[\s\S]*"topic"[\s\S]*\}/,
    label: 'curiosity extractor',
    validate: (p) => {
      if (!p || typeof p !== 'object') return null;
      const topic = str(p.topic);
      if (!topic) return null;

      const findings = (Array.isArray(p.findings) ? p.findings : [])
        .filter((f: unknown) => f && typeof f === 'object' && str((f as any).claim))
        .slice(0, 8)
        .map((f: any) => ({
          claim: str(f.claim),
          evidence: str(f.evidence) || undefined,
          confidence: CONFIDENCES.includes(f.confidence) ? (f.confidence as Confidence) : 'low',
        }));

      const frontier = (Array.isArray(p.frontier) ? p.frontier : [])
        .filter((f: unknown) => f && typeof f === 'object' && str((f as any).question))
        .slice(0, 3)
        .map((f: any) => ({
          question: str(f.question),
          whyInteresting: str(f.why_interesting ?? f.whyInteresting),
          bridge: str(f.bridge) || undefined,
          distance: num(f.distance, 1),
          surpriseScore: num(f.surprise_score ?? f.surpriseScore, 0.5),
        }));

      const surprises = strList(p.surprises, 5);
      const noSurpriseRaw = p.no_surprise ?? p.noSurprise;
      const noSurprise =
        typeof noSurpriseRaw === 'boolean' ? noSurpriseRaw : surprises.length === 0;

      const d = p.dispatch;
      const hook = d && typeof d === 'object' ? str(d.hook) : '';
      const dispatch: ExtractedDispatch | null = hook
        ? {
            hook,
            whyCare: str(d.why_care ?? d.whyCare),
            evidence: str(d.evidence),
            action: str(d.action),
            question: str(d.question) || undefined,
          }
        : null;

      return {
        extraction: {
          topic,
          findings,
          surprises,
          openQuestions: strList(p.open_questions ?? p.openQuestions, 5),
          answeredQuestions: strList(p.answered_questions ?? p.answeredQuestions, 5),
          frontier,
          servedDirectiveIds: strList(p.served_directive_ids ?? p.servedDirectiveIds, 10),
          noSurprise,
          interests: strList(p.interests, 3),
        },
        dispatch,
      };
    },
  });
}

export async function runExtractor(
  client: LLMClient,
  model: string,
  input: ExtractorInput,
  logger: Pick<Logger, 'warn'>
): Promise<(ExtractorResult & { usage?: TokenUsage }) | null> {
  const { system, prompt } = buildExtractorPrompt(input);
  for (const temperature of [0.3, 0]) {
    const res = await client.generate(prompt, { system, model, temperature });
    const parsed = parseExtractorResult(res.text, logger);
    if (parsed) return { ...parsed, usage: res.usage };
  }
  return null;
}

/** Messages shorter than this ("thanks!", "ok") are not instructions. */
export const MIN_DIRECTIVE_CHARS = 15;

/**
 * Watcher phase 0: how well a bot (later, the watcher) says what it is doing
 * right now, scored against the live presence the dashboard reads. Pure.
 *
 * Plan: docs/plans/watcher-implementation-plan.md, "Phase 0: baseline".
 */
import { parseLLMJson } from '../../bot/llm-json-parser';
import { textSimilarity, titleTokens } from '../../hygiene/text-utils';
import type { LivePresence } from '../../stats/presence-tracker';

/** What the subject said about itself. Every field is optional in the reply. */
export interface IntrospectionAnswer {
  phase: string | null;
  tool: string | null;
  goal: string | null;
  cause: string | null;
}

/** Ground truth at question time: the presence plus what the cycle serves, when known. */
export type IntrospectionTruth = LivePresence & {
  goalId?: string | null;
  goalTitle?: string | null;
  plan?: string | null;
};

/** `unknown`: the truth has nothing to compare against; left out of the score. */
export type FieldVerdict = 'match' | 'miss' | 'unknown';

export interface IntrospectionScore {
  parsed: boolean;
  /** Matches over known fields, 0–1. 0 when nothing is known or the answer did not parse. */
  score: number;
  fields: Record<keyof IntrospectionAnswer, FieldVerdict>;
}

const FIELDS: Array<keyof IntrospectionAnswer> = ['phase', 'tool', 'goal', 'cause'];

/** Words an idle subject may use for its phase. */
const IDLE_PHASES = new Set(['', 'idle', 'none', 'waiting', 'sleeping', 'between cycles']);
/** `textSimilarity` of the answer's goal against the goal title. */
export const GOAL_TITLE_THRESHOLD = 0.6;
/** Share of the answer's cause words that must appear in the plan. */
export const CAUSE_COVERAGE_THRESHOLD = 0.5;

/** Share of a held item's words an answer must cover to name it (watcher self-report). */
export const HELD_COVERAGE_THRESHOLD = 0.5;

/**
 * Share of `target`'s content words (`titleTokens`) that appear in `answer`.
 * 0 when the target has none. Measured on the target, so a long, chatty
 * answer that names the item still covers it.
 */
export function tokenCoverage(answer: string | null | undefined, target: string): number {
  const want = new Set(titleTokens(target));
  if (want.size === 0) return 0;
  const said = new Set(titleTokens(answer ?? ''));
  let hit = 0;
  for (const w of want) if (said.has(w)) hit++;
  return hit / want.size;
}

const silentLogger = { warn: () => {} };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Read the JSON object of an introspection reply. null when there is none. */
export function parseIntrospectionAnswer(text: string): IntrospectionAnswer | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  return parseLLMJson<IntrospectionAnswer>(text, silentLogger, {
    label: 'introspection',
    extractPattern: /\{[\s\S]*\}/,
    validate: (parsed) => {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      if (!FIELDS.some((f) => f in parsed)) return null;
      return {
        phase: str(parsed.phase),
        tool: str(parsed.tool),
        goal: str(parsed.goal),
        cause: str(parsed.cause),
      };
    },
  });
}

/** `planner:start` → `planner`. */
function stage(phase: string | null): string {
  return (phase ?? '').toLowerCase().trim().split(':')[0] ?? '';
}

function phaseVerdict(answer: string | null, truth: IntrospectionTruth): FieldVerdict {
  const said = (answer ?? '').toLowerCase().trim();
  if (!truth.executing) return IDLE_PHASES.has(said) ? 'match' : 'miss';
  const expected = stage(truth.phase);
  if (!expected) return 'unknown';
  return stage(answer) === expected ? 'match' : 'miss';
}

function toolVerdict(answer: string | null, truth: IntrospectionTruth): FieldVerdict {
  const said = (answer ?? '').toLowerCase().trim();
  const expected = (truth.currentTool ?? '').toLowerCase().trim();
  return said === expected ? 'match' : 'miss';
}

function goalVerdict(answer: string | null, truth: IntrospectionTruth): FieldVerdict {
  const id = str(truth.goalId);
  const title = str(truth.goalTitle);
  if (!id && !title) return 'unknown';
  if (!answer) return 'miss';
  if (id && answer.toLowerCase().includes(id.toLowerCase())) return 'match';
  if (title && textSimilarity(answer, title) >= GOAL_TITLE_THRESHOLD) return 'match';
  return 'miss';
}

function causeVerdict(answer: string | null, truth: IntrospectionTruth): FieldVerdict {
  const plan = str(truth.plan);
  if (!plan) return 'unknown';
  const said = titleTokens(answer ?? '');
  if (said.length === 0) return 'miss';
  const planWords = new Set(titleTokens(plan));
  const covered = said.filter((w) => planWords.has(w)).length / said.length;
  return covered >= CAUSE_COVERAGE_THRESHOLD ? 'match' : 'miss';
}

/** Field-level match of an answer against the truth. A null answer (unparsable) scores 0. */
export function scoreIntrospection(
  answer: IntrospectionAnswer | null,
  truth: IntrospectionTruth
): IntrospectionScore {
  if (!answer) {
    return {
      parsed: false,
      score: 0,
      fields: { phase: 'miss', tool: 'miss', goal: 'miss', cause: 'miss' },
    };
  }
  const fields = {
    phase: phaseVerdict(answer.phase, truth),
    tool: toolVerdict(answer.tool, truth),
    goal: goalVerdict(answer.goal, truth),
    cause: causeVerdict(answer.cause, truth),
  };
  const known = FIELDS.filter((f) => fields[f] !== 'unknown');
  const matched = known.filter((f) => fields[f] === 'match').length;
  return { parsed: true, score: known.length === 0 ? 0 : matched / known.length, fields };
}

/** Metric 3 per subject (phase 4): what the page and `GET /api/watcher/self` show. */
export interface IntrospectionSubjectSummary {
  subject: string;
  /** Rows with a numeric score. */
  n: number;
  /** Mean score, 0 when n is 0. */
  score: number;
  lastAt: string | null;
  /** Match share per field over the rows where the field was known; null = never known. */
  fields: Record<keyof IntrospectionAnswer, number | null>;
}

/** One summary per subject, `watcher` first, then by name. Pure; never NaN. */
export function summarizeIntrospection(
  rows: Array<{
    ts?: string;
    subject?: string;
    score?: number;
    fields?: Partial<Record<keyof IntrospectionAnswer, FieldVerdict>>;
  }>
): IntrospectionSubjectSummary[] {
  const groups = new Map<string, typeof rows>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.score !== 'number' || !Number.isFinite(r.score)) continue;
    const subject = typeof r.subject === 'string' && r.subject ? r.subject : 'unknown';
    const list = groups.get(subject) ?? [];
    list.push(r);
    groups.set(subject, list);
  }
  const out: IntrospectionSubjectSummary[] = [];
  for (const [subject, list] of groups) {
    const fields = {} as Record<keyof IntrospectionAnswer, number | null>;
    for (const f of FIELDS) {
      const known = list.filter((r) => r.fields?.[f] === 'match' || r.fields?.[f] === 'miss');
      fields[f] = known.length
        ? known.filter((r) => r.fields?.[f] === 'match').length / known.length
        : null;
    }
    const stamps = list.map((r) => r.ts).filter((t): t is string => typeof t === 'string');
    out.push({
      subject,
      n: list.length,
      score: list.reduce((sum, r) => sum + (r.score as number), 0) / list.length,
      lastAt: stamps.length ? (stamps.sort().at(-1) as string) : null,
      fields,
    });
  }
  return out.sort((a, b) =>
    a.subject === 'watcher' ? -1 : b.subject === 'watcher' ? 1 : a.subject.localeCompare(b.subject)
  );
}

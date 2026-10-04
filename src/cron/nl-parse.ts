/**
 * Natural-language cron proposals (session S8 of docs/plans/jarvis-fleet-plan.md).
 *
 * Pure functions behind `POST /api/cron/parse`: the deterministic fallback
 * parser (so the preview works with the LLM down), cron -> human text, the
 * prompt the bot's LLM gets, validation of what it sends back, and
 * `composeProposal`, which turns either source into the API shape. Nothing in
 * here talks to an LLM or creates a job.
 */
import { Cron } from 'croner';
import { parseLLMJson } from '../bot/llm-json-parser';
import type { OperatorConfig } from '../config';
import type { Logger } from '../logger';
import { OPERATOR_CHAT_ALIAS, resolveOperatorTarget } from '../tools/send-proactive-message';
import { computeNextRunAtMs } from './schedule';

export type CronConfidence = 'high' | 'medium' | 'low';
export type CronProposalSource = 'llm' | 'fallback';

/** What the bot's LLM is asked to return (validated by `validateLlmProposal`). */
export interface LlmCronProposal {
  schedule: string;
  instruction: string;
  chatId?: 'operator' | number;
  confidence: CronConfidence;
  explanation: string;
  warnings: string[];
}

/** The API shape (add-only). `schedule` is a 5-field cron expression. */
export interface CronProposal {
  schedule: string;
  tz: string;
  scheduleHuman: string;
  nextRunAt: string | null;
  instruction: string;
  name: string;
  botId: string;
  chatId: 'operator' | number;
  /** `config.operator.telegramChatId`, so the UI can post a numeric chatId. */
  operatorChatId: number | null;
  confidence: CronConfidence;
  explanation: string;
  warnings: string[];
  source: CronProposalSource;
}

export interface DeterministicParse {
  schedule: string;
  instruction: string;
  confidence: CronConfidence;
  /** True when a schedule phrase was found in the text. */
  matched: boolean;
  /** The phrase the schedule was read from ('' when nothing matched). */
  phrase: string;
  warnings: string[];
}

export const CRON_FIELDS = 5;
/** Every day at 09:00 — what the fallback proposes when the text has no schedule. */
export const DEFAULT_FALLBACK_SCHEDULE = '0 9 * * *';
const DEFAULT_HOUR = 9;
const JOB_NAME_MAX = 60;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_LOOKUP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  wednes: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
  sat: 6,
  satur: 6,
};
const DAY_WORD = '(?:sun|mon|tues|tue|wednes|wed|thurs|thur|thu|fri|satur|sat)(?:day)?s?';

// ---------------------------------------------------------------------------
// Cron expression helpers
// ---------------------------------------------------------------------------

/** A 5-field cron expression croner can schedule. */
export function isCronExpr(expr: unknown): expr is string {
  if (typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== CRON_FIELDS || fields.some((f) => !/^[\d*/,\-]+$/.test(f))) return false;
  try {
    new Cron(fields.join(' '));
    return true;
  } catch {
    return false;
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function humanTime(m: string, h: string): string | null {
  if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(h)) return null;
  const hh = Number(h);
  const mm = Number(m);
  if (hh > 23 || mm > 59) return null;
  return `${pad2(hh)}:${pad2(mm)}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function humanDays(dow: string): string | null {
  if (dow === '1-5') return 'Weekdays';
  if (dow === '6,0' || dow === '0,6' || dow === '6-7' || dow === '0,6') return 'Weekends';
  if (!/^\d(?:,\d)*$/.test(dow)) return null;
  const names = dow.split(',').map((d) => DAY_NAMES[Number(d) % 7]);
  if (names.some((n) => !n)) return null;
  return `Every ${joinNames(names)}`;
}

// "0 STAR/3 * * *" (every third hour) -> "Every 3 hours"; unknown shapes come back as `Cron "<expr>"`.
export function cronToHuman(expr: string, tz?: string): string {
  const text = describeCron(String(expr ?? '').trim());
  return tz ? `${text} (${tz})` : text;
}

function describeCron(expr: string): string {
  const raw = `Cron "${expr}"`;
  const f = expr.split(/\s+/);
  if (f.length !== CRON_FIELDS) return raw;
  const [m, h, dom, mon, dow] = f;
  if (mon !== '*') return raw;

  const everyN = (s: string) => (/^\*\/\d+$/.test(s) ? Number(s.slice(2)) : null);
  const minuteStep = everyN(m);
  const hourStep = everyN(h);
  const dayStep = everyN(dom);

  if (dom === '*' && dow === '*') {
    if (m === '*' && h === '*') return 'Every minute';
    if (minuteStep && h === '*') return `Every ${minuteStep} minutes`;
    if (/^\d{1,2}$/.test(m) && hourStep) {
      const at = m === '0' ? '' : ` at :${pad2(Number(m))}`;
      return `Every ${hourStep} hours${at}`;
    }
    if (/^\d{1,2}$/.test(m) && h === '*') {
      return m === '0' ? 'Every hour' : `Every hour at :${pad2(Number(m))}`;
    }
    const time = humanTime(m, h);
    return time ? `Every day at ${time}` : raw;
  }

  const time = humanTime(m, h);
  if (!time) return raw;
  if (dom === '*') {
    const days = humanDays(dow);
    return days ? `${days} at ${time}` : raw;
  }
  if (dow !== '*') return raw;
  if (dayStep) return `Every ${dayStep} days at ${time}`;
  if (/^\d{1,2}$/.test(dom)) return `On day ${Number(dom)} of every month at ${time}`;
  return raw;
}

// ---------------------------------------------------------------------------
// Deterministic parser
// ---------------------------------------------------------------------------

const DELIVERY_RE =
  /(?:\b(?:and|then)\b\s*|,\s*)?\b(?:(?:please\s+)?(?:message|msg|tell|ping|notify|remind|dm|text|email|alert|update|send)\s+(?:it\s+to\s+)?me(?:\s+(?:about|with)\s+(?:it|them|that|the\s+results?|what\s+you\s+find))?|let\s+me\s+know(?:\s+(?:about\s+it|the\s+results?|what\s+you\s+find))?|report\s+back(?:\s+to\s+me)?|keep\s+me\s+posted)\b/gi;

/** Does the text ask for the result to reach the human ("message me", "tell me", ...)? */
export function mentionsOperator(text: string): boolean {
  DELIVERY_RE.lastIndex = 0;
  return DELIVERY_RE.test(String(text ?? ''));
}

interface TimeMatch {
  h: number;
  m: number;
  span: string;
}

function parseTime(t: string): TimeMatch | null {
  const named = t.match(/\bat\s+(noon|midday|midnight)\b/);
  if (named) {
    return { h: named[1] === 'midnight' ? 0 : 12, m: 0, span: named[0] };
  }
  const withAt = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\b|\s|$)/);
  const bare = withAt ? null : t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/);
  const hit = withAt ?? bare;
  if (!hit) return null;
  let h = Number(hit[1]);
  const m = hit[2] ? Number(hit[2]) : 0;
  const suffix = hit[3]?.replace(/\./g, '');
  if (h > 23 || m > 59) return null;
  if (suffix === 'pm' && h < 12) h += 12;
  if (suffix === 'am' && h === 12) h = 0;
  return { h, m, span: hit[0] };
}

interface ScheduleMatch {
  schedule: string;
  span: string;
  usesTime: boolean;
  warnings: string[];
}

type Rule = { re: RegExp; build: (m: RegExpMatchArray, ctx: RuleCtx) => ScheduleMatch | null };
interface RuleCtx {
  time: TimeMatch | null;
  /** Hour/minute to use for "at HH:MM" shapes: the parsed time or the 09:00 default. */
  H: number;
  M: number;
  daily: (hour: number, span: string) => ScheduleMatch;
  at: (schedule: string, m: RegExpMatchArray, warnings?: string[]) => ScheduleMatch;
}

const hit = (schedule: string, m: RegExpMatchArray): ScheduleMatch => ({
  schedule,
  span: m[0],
  usesTime: false,
  warnings: [],
});

const DAY_LIST_RE = new RegExp(
  `\\b(?:every|each|on)\\s+(${DAY_WORD}(?:\\s*(?:,|and|&)\\s*${DAY_WORD})*)\\b`
);

/** Ordered: the first rule whose regex matches and whose builder accepts wins. */
const SCHEDULE_RULES: Rule[] = [
  {
    re: /\bevery\s+(\d+)\s*(?:minutes?|mins?|min)\b/,
    build: (m) => {
      const n = Number(m[1]);
      if (n >= 1 && n <= 59) return hit(`*/${n} * * * *`, m);
      if (n % 60 === 0 && n / 60 <= 23) return hit(`0 */${n / 60} * * *`, m);
      return null;
    },
  },
  { re: /\bevery\s+minute\b/, build: (m) => hit('* * * * *', m) },
  {
    re: /\bevery\s+(\d+)\s*(?:hours?|hrs?|hr)\b/,
    build: (m, ctx) => {
      const n = Number(m[1]);
      if (n >= 1 && n <= 23) return hit(`0 */${n} * * *`, m);
      if (n === 24) return ctx.daily(DEFAULT_HOUR, m[0]);
      return null;
    },
  },
  { re: /\bevery\s+hour\b|\bhourly\b/, build: (m) => hit('0 * * * *', m) },
  {
    re: /\bevery\s+(\d+)\s*days?\b/,
    build: (m, ctx) => {
      const n = Number(m[1]);
      if (n === 1) return ctx.daily(DEFAULT_HOUR, m[0]);
      if (n >= 2 && n <= 31) return ctx.at(`${ctx.M} ${ctx.H} */${n} * *`, m);
      return null;
    },
  },
  {
    re: /\bevery\s+(\d+)\s*weeks?\b/,
    build: (m, ctx) =>
      ctx.at(`${ctx.M} ${ctx.H} * * 1`, m, [
        `Cron cannot express "${m[0]}"; proposing every Monday instead.`,
      ]),
  },
  {
    re: /\b(?:every|each|on)\s+(?:weekdays?|working\s+days?|business\s+days?)\b/,
    build: (m, ctx) => ctx.at(`${ctx.M} ${ctx.H} * * 1-5`, m),
  },
  {
    re: /\b(?:every|each|on)\s+weekends?\b/,
    build: (m, ctx) => ctx.at(`${ctx.M} ${ctx.H} * * 6,0`, m),
  },
  {
    re: DAY_LIST_RE,
    build: (m, ctx) => {
      const days = Array.from(
        new Set(
          m[1]
            .split(/\s*(?:,|and|&)\s*/)
            .map((w) => w.replace(/days?$|s$/, '').replace(/day$/, ''))
            .map((w) => DAY_LOOKUP[w] ?? DAY_LOOKUP[w.replace(/s$/, '')])
            .filter((d): d is number => typeof d === 'number')
        )
      ).sort((a, b) => a - b);
      return days.length > 0 ? ctx.at(`${ctx.M} ${ctx.H} * * ${days.join(',')}`, m) : null;
    },
  },
  {
    re: /\bevery\s+(day|morning|afternoon|evening|night)\b|\bdaily\b|\beach\s+day\b/,
    build: (m, ctx) => {
      const word = m[1] ?? 'day';
      const hour =
        { morning: 9, afternoon: 15, evening: 18, night: 21, day: DEFAULT_HOUR }[word] ??
        DEFAULT_HOUR;
      return ctx.daily(hour, m[0]);
    },
  },
  {
    re: /\bweekly\b|\bevery\s+week\b|\bonce\s+a\s+week\b/,
    build: (m, ctx) => ctx.at(`${ctx.M} ${ctx.H} * * 1`, m),
  },
  {
    re: /\bmonthly\b|\bevery\s+month\b|\bonce\s+a\s+month\b/,
    build: (m, ctx) => ctx.at(`${ctx.M} ${ctx.H} 1 * *`, m),
  },
];

function matchSchedule(t: string, time: TimeMatch | null): ScheduleMatch | null {
  const ctx: RuleCtx = {
    time,
    H: time ? time.h : DEFAULT_HOUR,
    M: time ? time.m : 0,
    daily: (hour, span) => ({
      schedule: `${time ? time.m : 0} ${time ? time.h : hour} * * *`,
      span,
      usesTime: true,
      warnings: [],
    }),
    at: (schedule, m, warnings = []) => ({ schedule, span: m[0], usesTime: true, warnings }),
  };
  for (const rule of SCHEDULE_RULES) {
    const m = t.match(rule.re);
    if (!m) continue;
    const r = rule.build(m, ctx);
    if (r) return r;
  }
  if (time) return ctx.daily(time.h, '');
  return null;
}

function removeSpan(text: string, span: string): string {
  if (!span) return text;
  const idx = text.toLowerCase().indexOf(span.toLowerCase());
  if (idx < 0) return text;
  return `${text.slice(0, idx)} ${text.slice(idx + span.length)}`;
}

function tidyInstruction(text: string, original: string): string {
  let s = text
    .replace(DELIVERY_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
  // Leftover connectors at either edge: "and check the boards", "check the boards and".
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/^(?:and|then|,|\.|;|-|please)\s*/i, '')
      .replace(/\s*(?:\band\b|\bthen\b|,|\.|;|-)$/i, '')
      .trim();
  }
  if (!s) return original.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Read a schedule out of free text without an LLM. Handles "every N
 * minutes/hours/days", "every day at HH:MM", "every monday at 9", weekdays,
 * weekends, weekly/monthly, and a literal 5-field cron expression. Returns
 * the daily default with `matched: false` when nothing applies.
 */
export function deterministicParse(text: string): DeterministicParse {
  const original = String(text ?? '').trim();
  const t = original.toLowerCase();

  const literal = t.match(/(?:^|\s)((?:[\d*/,\-]+\s+){4}[\d*/,\-]+)(?=\s|$)/);
  if (literal && isCronExpr(literal[1])) {
    return {
      schedule: literal[1].trim(),
      instruction: tidyInstruction(removeSpan(original, literal[1]), original),
      confidence: 'high',
      matched: true,
      phrase: literal[1].trim(),
      warnings: [],
    };
  }

  const time = parseTime(t);
  const hit = matchSchedule(t, time);
  if (!hit) {
    return {
      schedule: DEFAULT_FALLBACK_SCHEDULE,
      instruction: tidyInstruction(original, original),
      confidence: 'low',
      matched: false,
      phrase: '',
      warnings: [],
    };
  }
  let rest = removeSpan(original, hit.span);
  if (time && hit.usesTime) rest = removeSpan(rest, time.span);
  const phrase = [hit.span, time && hit.usesTime ? time.span : ''].filter(Boolean).join(' ').trim();
  return {
    schedule: hit.schedule,
    instruction: tidyInstruction(rest, original),
    confidence: 'medium',
    matched: true,
    phrase,
    warnings: hit.warnings,
  };
}

// ---------------------------------------------------------------------------
// LLM side
// ---------------------------------------------------------------------------

export interface ParsePromptInput {
  text: string;
  botId: string;
  botName: string;
  tz: string;
  nowIso: string;
  operatorConfigured: boolean;
}

/** The prompt the bot's LLM gets. Timezone and "now" are explicit so "at 9" is unambiguous. */
export function buildParsePrompt(input: ParsePromptInput): string {
  const operatorLine = input.operatorConfigured
    ? 'The operator chat is configured, so "operator" is deliverable.'
    : 'NOTE: no operator chat is configured yet; still use "operator" and add a warning saying so.';
  return [
    `You turn a human request into ONE scheduled instruction for the agent "${input.botName}" (id: ${input.botId}).`,
    `Current time: ${input.nowIso}. Timezone for every schedule: ${input.tz}. Times the human mentions are in that timezone.`,
    '',
    'Request:',
    `"""${input.text}"""`,
    '',
    'Answer with a single JSON object and nothing else:',
    '{"schedule": "<5-field cron: minute hour day-of-month month day-of-week>",',
    ' "instruction": "<what the agent does on each run: imperative, one to three sentences, without the schedule or the delivery words>",',
    ' "chatId": "operator" | <number>,',
    ' "confidence": "high" | "medium" | "low",',
    ' "explanation": "<one sentence, in the language of the request, saying when it runs>",',
    ' "warnings": ["<anything ambiguous, impossible or assumed>"]}',
    '',
    'Rules:',
    '- Standard 5-field cron only: no seconds field, no @daily/@hourly. "every 3 hours" -> "0 */3 * * *"; "every day at 8:30" -> "30 8 * * *"; "every monday at 9" -> "0 9 * * 1"; weekdays -> "* * 1-5".',
    '- "message me", "tell me", "let me know", "ping me" and similar mean chatId "operator" (the human running this fleet). Use "operator" unless the request quotes a numeric chat id verbatim. Never invent a chat id.',
    `- ${operatorLine}`,
    '- If the request has no schedule at all, pick a sensible one, set confidence "low" and say so in warnings.',
    '- Keep the instruction self-contained: the agent will read it cold at every run.',
  ].join('\n');
}

const CONFIDENCES: CronConfidence[] = ['high', 'medium', 'low'];

/** Validate/normalise the object the LLM returned; null rejects it. */
export function validateLlmProposal(parsed: unknown): LlmCronProposal | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const schedule = typeof p.schedule === 'string' ? p.schedule.trim().split(/\s+/).join(' ') : '';
  if (!isCronExpr(schedule)) return null;
  const instruction = typeof p.instruction === 'string' ? p.instruction.trim() : '';
  if (!instruction) return null;

  let chatId: LlmCronProposal['chatId'];
  if (typeof p.chatId === 'string' && p.chatId.trim().toLowerCase() === OPERATOR_CHAT_ALIAS) {
    chatId = 'operator';
  } else if (typeof p.chatId === 'number' && Number.isFinite(p.chatId) && p.chatId !== 0) {
    chatId = p.chatId;
  }
  const conf = typeof p.confidence === 'string' ? p.confidence.toLowerCase() : '';
  const confidence = CONFIDENCES.includes(conf as CronConfidence)
    ? (conf as CronConfidence)
    : 'medium';
  const explanation = typeof p.explanation === 'string' ? p.explanation.trim() : '';
  const warnings = Array.isArray(p.warnings)
    ? p.warnings.filter((w): w is string => typeof w === 'string' && w.trim() !== '')
    : [];
  return {
    schedule,
    instruction,
    ...(chatId !== undefined ? { chatId } : {}),
    confidence,
    explanation,
    warnings,
  };
}

/** Raw LLM output -> validated proposal (fences and prose tolerated), or null. */
export function parseLlmProposal(
  raw: string,
  logger: Pick<Logger, 'warn'>
): LlmCronProposal | null {
  return parseLLMJson<LlmCronProposal>(String(raw ?? ''), logger, {
    extractPattern: /\{[\s\S]*"schedule"[\s\S]*\}/,
    validate: validateLlmProposal,
    label: 'cron-parse',
  });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Job name from the instruction: first line, capped at 60 chars. */
export function jobNameFor(instruction: string): string {
  const s = String(instruction ?? '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return 'Automation';
  return s.length > JOB_NAME_MAX ? `${s.slice(0, JOB_NAME_MAX - 1)}…` : s;
}

export interface ComposeInput {
  text: string;
  botId: string;
  tz: string;
  nowMs: number;
  operator: OperatorConfig | null | undefined;
  /** Validated LLM proposal, or null to use the deterministic parser. */
  llm: LlmCronProposal | null;
  /** Why there is no LLM proposal (surfaced as the first warning). */
  llmNote?: string;
}

/** Build the API proposal from the LLM answer or, without one, from the built-in parser. */
export function composeProposal(input: ComposeInput): CronProposal {
  const text = String(input.text ?? '').trim();
  const fb = deterministicParse(text);
  const operatorChatId = resolveOperatorTarget(OPERATOR_CHAT_ALIAS, input.operator);
  const operatorId =
    operatorChatId.kind === 'operator' && typeof operatorChatId.chatId === 'number'
      ? operatorChatId.chatId
      : null;

  let schedule: string;
  let instruction: string;
  let confidence: CronConfidence;
  let explanation: string;
  let chatId: CronProposal['chatId'] = 'operator';
  const warnings: string[] = [];
  let source: CronProposalSource;

  if (input.llm) {
    source = 'llm';
    schedule = input.llm.schedule;
    instruction = input.llm.instruction;
    confidence = input.llm.confidence;
    explanation = input.llm.explanation;
    warnings.push(...input.llm.warnings);
    if (typeof input.llm.chatId === 'number') {
      if (text.includes(String(input.llm.chatId))) {
        chatId = input.llm.chatId;
      } else {
        warnings.push(
          `The agent suggested chat id ${input.llm.chatId}, which is not in your text; delivering to the operator instead.`
        );
      }
    }
    if (fb.matched && fb.schedule !== schedule) {
      warnings.push(
        `The built-in parser read it as "${cronToHuman(fb.schedule)}" (${fb.schedule}); double-check the schedule.`
      );
    }
  } else {
    source = 'fallback';
    schedule = fb.schedule;
    instruction = fb.instruction;
    confidence = fb.confidence;
    if (input.llmNote) warnings.push(`${input.llmNote}; used the built-in parser.`);
    if (fb.matched) {
      explanation = `Read "${fb.phrase}" as ${cronToHuman(fb.schedule).toLowerCase()}.`;
    } else {
      explanation = `No schedule found in the text; defaulted to ${cronToHuman(fb.schedule).toLowerCase()}.`;
      warnings.push('No schedule found in the text — edit the cron field before creating the job.');
    }
    warnings.push(...fb.warnings);
  }

  if (chatId === 'operator' && operatorId === null) {
    warnings.push(
      'No operator Telegram chat id is configured (config.operator.telegramChatId); set a chat id before creating the job.'
    );
  }

  const nextMs = computeNextRunAtMs({ kind: 'cron', expr: schedule, tz: input.tz }, input.nowMs);
  return {
    schedule,
    tz: input.tz,
    scheduleHuman: cronToHuman(schedule, input.tz),
    nextRunAt: typeof nextMs === 'number' ? new Date(nextMs).toISOString() : null,
    instruction,
    name: jobNameFor(instruction),
    botId: input.botId,
    chatId,
    operatorChatId: operatorId,
    confidence,
    explanation,
    warnings,
    source,
  };
}

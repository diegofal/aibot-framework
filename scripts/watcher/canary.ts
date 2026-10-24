#!/usr/bin/env bun
/**
 * Watcher phase 0: cross-bot recall canary.
 *
 *   bun scripts/watcher/canary.ts plant --bot <A> --fact "…" [--question "…"] [--name <display name>]
 *   bun scripts/watcher/canary.ts check --bot <B> --id <canary id> [--expect <word>[,<word>]]
 *
 * `plant` tells bot A a fact in a dashboard conversation thread and records it;
 * `check` asks bot B, in a thread of its own, a question that does not contain
 * the fact and records whether B's answer has it: any of the fact's rarest
 * content words (`canaryKeywords`, stored at plant time; `--expect` overrides
 * and requires all of its words) as a whole word, case- and accent-insensitive. Sentence `textSimilarity` is kept in the row as a
 * secondary signal (and is the test only for a fact with no content word).
 * Live, 2026-10-24: a short correct reply ("It's "heliotrope." …") scored 0.29
 * against the whole planted sentence. Both rows go to `<data>/watcher/canaries.jsonl`.
 *
 * Why the dashboard thread (`POST /api/conversations/:botId` then
 * `…/:id/messages`, reply polled from `…/:id/status`): it is an operator
 * surface. A REST chat sender is a public user whose facts stay private by
 * design, so a fact planted there could never be recalled by another bot. In
 * multi-tenant mode pass an admin `--token`. Before phase 2 this fails; with
 * the watcher noticing, B should find the fact through `fleet_memory_search`.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mentionsWord,
  normalizeTitle,
  textSimilarity,
  titleTokens,
} from '../../src/hygiene/text-utils';
import { fail, parseArgs, resolveCliContext } from '../system-cli';
import { cliDataDir } from './baseline';
import { url, type HttpDeps, headers } from './introspect';

/** A sentence of the answer at or above this similarity to the fact counts as recall. */
export const CANARY_MATCH_THRESHOLD = 0.6;
export const CANARY_THREAD_TITLE = 'Watcher canary';
const DEFAULT_POLL_MS = 2_000;
/** A Claude CLI reply with tools can take minutes. */
const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_CANARY_QUESTION =
  'Has anyone told you a fact recently that you were asked to remember? If so, repeat it exactly in one sentence.';

export interface CanaryPlant {
  kind: 'plant';
  id: string;
  fact: string;
  question: string;
  plantedAt: string;
  bot: string;
  /** The dashboard thread the fact was told in. */
  conversationId: string;
  /** Bot A's reply, verbatim (LLM output, kept as a quoted field). */
  reply: string;
  /** The fact's distinctive words, rarest first (`canaryKeywords`). Absent on older plants. */
  keywords?: string[];
}

export interface CanaryCheck {
  kind: 'check';
  id: string;
  bot: string;
  plantedBy: string;
  checkedAt: string;
  /** The dashboard thread B was asked in. */
  conversationId: string;
  /** Bot B's answer, verbatim (LLM output, kept as a quoted field). */
  answer: string;
  found: boolean;
  /** Secondary signal: best sentence similarity of the answer to the fact. */
  similarity: number;
  /** `all` for `--expect` words, `any` for the plant's keywords. Absent on older checks. */
  match?: 'all' | 'any';
  /** The words the answer had to name (`--expect`, else any of the plant's keywords). */
  expected: string[];
  matchedBy: 'keyword' | 'similarity' | null;
}

export interface CanaryDeps extends HttpDeps {
  dataDir: string;
  now?: () => number;
  newId?: () => string;
  write?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ThreadOptions {
  title?: string;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
  return ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
}

/**
 * One message to a bot in a new dashboard thread (an operator surface): create
 * the thread, post the message, poll the status until the reply lands.
 * Throws on non-2xx, a failed generation, or no reply within the timeout.
 */
export async function askInOperatorThread(
  deps: HttpDeps,
  botId: string,
  message: string,
  opts: ThreadOptions = {}
): Promise<{ reply: string; conversationId: string }> {
  const bot = encodeURIComponent(botId);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const thread = await json(
    await deps.fetch(url(deps, `/api/conversations/${bot}`), {
      method: 'POST',
      headers: headers(deps),
      body: JSON.stringify({ type: 'general', title: opts.title ?? CANARY_THREAD_TITLE }),
    }),
    `creating a thread with ${botId}`
  );
  if (typeof thread.id !== 'string') throw new Error(`thread with ${botId}: no id in response`);
  const id = encodeURIComponent(thread.id);

  await json(
    await deps.fetch(url(deps, `/api/conversations/${bot}/${id}/messages`), {
      method: 'POST',
      headers: headers(deps),
      body: JSON.stringify({ message }),
    }),
    `posting to ${botId}`
  );

  const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
  for (let i = 0; i < attempts; i++) {
    const status = await json(
      await deps.fetch(url(deps, `/api/conversations/${bot}/${id}/status`), {
        headers: headers(deps),
      }),
      `waiting for ${botId}`
    );
    if (status.status === 'error') {
      throw new Error(`${botId} could not reply: ${String(status.error ?? 'unknown error')}`);
    }
    const last = status.lastBotMessage as { content?: unknown } | null | undefined;
    if (status.status === 'idle' && typeof last?.content === 'string') {
      return { reply: last.content, conversationId: thread.id };
    }
    await sleep(pollMs);
  }
  throw new Error(`${botId}: no reply within ${Math.round(timeoutMs / 1000)} s`);
}

/**
 * What `plant` tells bot A: the fact, addressed to the bot by its display name
 * once. A fact that already names the bot is not addressed again (the live
 * plant of 2026-10-23 read "Finny … finny"). Whole words only: "Max" is not
 * named by "maximum".
 */
export function canaryPlantMessage(fact: string, name?: string): string {
  const who = name?.trim();
  const named = !!who && mentionsWord(fact, who);
  return who && !named
    ? `${who}, please remember this fact: ${fact}`
    : `Please remember this fact: ${fact}`;
}

/** The bot's display name (`GET /api/agents/:id` → `name`); undefined when it cannot be read. */
export async function botDisplayName(deps: HttpDeps, botId: string): Promise<string | undefined> {
  try {
    const res = await deps.fetch(url(deps, `/api/agents/${encodeURIComponent(botId)}`), {
      headers: headers(deps),
    });
    if (!res.ok) return undefined;
    const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
    return typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** How many distinctive words a plant keeps. */
export const CANARY_KEYWORDS_MAX = 3;
/** Words of the plant message itself ("please remember this fact"). */
const CANARY_TEMPLATE_WORDS = new Set(['please', 'remember', 'fact']);

/**
 * Everyday English and Spanish words (accent-stripped, like `titleTokens`)
 * that an unrelated answer is likely to contain ("I'll check tomorrow").
 */
const CANARY_COMMON_WORDS = new Set([
  // en
  'about',
  'after',
  'again',
  'all',
  'also',
  'always',
  'any',
  'back',
  'because',
  'been',
  'before',
  'behind',
  'best',
  'big',
  'blue',
  'but',
  'can',
  'check',
  'come',
  'could',
  'day',
  'days',
  'did',
  'does',
  'done',
  'down',
  'each',
  'even',
  'every',
  'find',
  'first',
  'get',
  'give',
  'good',
  'great',
  'had',
  'has',
  'have',
  'here',
  'how',
  'just',
  'keep',
  'keeps',
  'know',
  'last',
  'like',
  'likes',
  'little',
  'long',
  'look',
  'make',
  'many',
  'more',
  'most',
  'much',
  'must',
  'need',
  'never',
  'new',
  'next',
  'not',
  'now',
  'old',
  'one',
  'only',
  'other',
  'out',
  'over',
  'people',
  'really',
  'right',
  'said',
  'same',
  'say',
  'see',
  'should',
  'some',
  'something',
  'soon',
  'still',
  'take',
  'tell',
  'than',
  'thank',
  'thanks',
  'then',
  'there',
  'they',
  'thing',
  'things',
  'think',
  'time',
  'today',
  'told',
  'tomorrow',
  'tonight',
  'too',
  'two',
  'under',
  'very',
  'want',
  'was',
  'water',
  'way',
  'week',
  'well',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'word',
  'work',
  'would',
  'year',
  'yes',
  'yesterday',
  'yet',
  'you',
  // es
  'ahora',
  'algo',
  'antes',
  'aqui',
  'asi',
  'ayer',
  'bien',
  'bueno',
  'cada',
  'casa',
  'cosa',
  'creo',
  'cuando',
  'decir',
  'desde',
  'despues',
  'dia',
  'dias',
  'donde',
  'entonces',
  'eso',
  'estoy',
  'gracias',
  'hace',
  'hacer',
  'hay',
  'hoy',
  'luego',
  'manana',
  'mismo',
  'mucho',
  'muy',
  'nada',
  'noche',
  'nos',
  'nunca',
  'otra',
  'otro',
  'palabra',
  'poco',
  'porque',
  'puede',
  'pues',
  'semana',
  'siempre',
  'solo',
  'tambien',
  'tengo',
  'tiempo',
  'todo',
  'todos',
  'vez',
  'ver',
  'voy',
]);

/**
 * The fact's distinctive content words, rarest first: `titleTokens` (no
 * stopwords) minus numbers and dates, words of ≤ 2 letters, the plant
 * template's words and every word of `exclude` (the question asked to bot B,
 * the bot's id and name: an answer echoing those proves nothing). Rarity: a
 * word outside `CANARY_COMMON_WORDS` beats any common one (common words are
 * kept only when the fact has nothing else), then longer first, ties in fact
 * order. At most `CANARY_KEYWORDS_MAX`.
 */
export function canaryKeywords(fact: string, opts: { exclude?: string[] } = {}): string[] {
  const drop = new Set((opts.exclude ?? []).flatMap((t) => titleTokens(t ?? '')));
  const seen = new Set<string>();
  const words: string[] = [];
  for (const w of titleTokens(fact ?? '')) {
    if (seen.has(w) || w.length <= 2 || /^\d+$/.test(w)) continue;
    if (drop.has(w) || CANARY_TEMPLATE_WORDS.has(w)) continue;
    seen.add(w);
    words.push(w);
  }
  const rare = words.filter((w) => !CANARY_COMMON_WORDS.has(w));
  return (rare.length > 0 ? rare : words)
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w.length - a.w.length || a.i - b.i)
    .slice(0, CANARY_KEYWORDS_MAX)
    .map((x) => x.w);
}

/**
 * Whether an answer recalls the canary: it names every `expected` word
 * (`match: 'all'`, the `--expect` words) or at least one (`'any'`, the
 * plant's stored keywords) — `mentionsWord`, both sides normalised
 * (`normalizeTitle`: case, accents, punctuation), since stored keywords are
 * accent-stripped ("asuncion" names "Asunción"). With no expected word, the
 * sentence similarity decides. The similarity is always returned as a
 * secondary signal.
 */
export function answerRecallsCanary(
  answer: string,
  fact: string,
  expected: string[],
  match: 'all' | 'any' = 'all'
): { found: boolean; similarity: number; matchedBy: 'keyword' | 'similarity' | null } {
  const { found: similar, similarity } = answerContainsFact(answer, fact);
  const words = expected.map((w) => w.trim()).filter(Boolean);
  if (words.length > 0) {
    const text = normalizeTitle(answer ?? '');
    const names = (w: string) => mentionsWord(text, normalizeTitle(w));
    const hit = match === 'any' ? words.some(names) : words.every(names);
    return { found: hit, similarity, matchedBy: hit ? 'keyword' : null };
  }
  return { found: similar, similarity, matchedBy: similar ? 'similarity' : null };
}

/** Best sentence-level similarity of the answer to the fact. */
export function answerContainsFact(
  answer: string,
  fact: string
): { found: boolean; similarity: number } {
  const sentences = (answer ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let best = 0;
  for (const s of sentences) best = Math.max(best, textSimilarity(s, fact));
  return { found: best >= CANARY_MATCH_THRESHOLD, similarity: best };
}

function canaryPath(dataDir: string): string {
  return join(dataDir, 'watcher', 'canaries.jsonl');
}

function append(dataDir: string, row: CanaryPlant | CanaryCheck): void {
  mkdirSync(join(dataDir, 'watcher'), { recursive: true });
  appendFileSync(canaryPath(dataDir), `${JSON.stringify(row)}\n`, 'utf-8');
}

function findPlant(dataDir: string, id: string): CanaryPlant | null {
  const path = canaryPath(dataDir);
  if (!existsSync(path)) return null;
  let found: CanaryPlant | null = null;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.kind === 'plant' && row.id === id) found = row;
    } catch {
      // malformed line: skipped
    }
  }
  return found;
}

export async function run(argv: string[], deps: CanaryDeps): Promise<CanaryPlant | CanaryCheck> {
  const args = parseArgs(argv);
  const command = args.positional[0];
  if (command !== 'plant' && command !== 'check') {
    throw new Error('usage: canary.ts plant --bot <A> --fact "…" | check --bot <B> --id <id>');
  }
  const bot = args.values.get('bot');
  if (!bot) throw new Error('--bot <id> is required');
  const http: HttpDeps = {
    fetch: deps.fetch,
    baseUrl: args.values.get('url') ?? deps.baseUrl,
    token: args.values.get('token') ?? deps.token,
  };
  const now = deps.now ?? Date.now;
  const thread: ThreadOptions = deps.sleep ? { sleep: deps.sleep } : {};
  const write = deps.write ?? ((l: string) => process.stdout.write(`${l}\n`));

  if (command === 'plant') {
    const fact = args.values.get('fact')?.trim();
    if (!fact) throw new Error('--fact "…" is required');
    const question = args.values.get('question')?.trim() || DEFAULT_CANARY_QUESTION;
    const name = args.values.get('name')?.trim() || (await botDisplayName(http, bot));
    const { reply, conversationId } = await askInOperatorThread(
      http,
      bot,
      canaryPlantMessage(fact, name),
      thread
    );
    const row: CanaryPlant = {
      kind: 'plant',
      id: deps.newId?.() ?? `c-${randomUUID().slice(0, 8)}`,
      fact,
      question,
      plantedAt: new Date(now()).toISOString(),
      bot,
      conversationId,
      reply,
      keywords: canaryKeywords(fact, { exclude: [question, bot, name ?? ''] }),
    };
    append(deps.dataDir, row);
    write(`planted ${row.id} in ${bot}`);
    return row;
  }

  const id = args.values.get('id');
  if (!id) throw new Error('--id <canary id> is required');
  const plant = findPlant(deps.dataDir, id);
  if (!plant) throw new Error(`canary ${id} not found in ${canaryPath(deps.dataDir)}`);
  const { reply: answer, conversationId } = await askInOperatorThread(
    http,
    bot,
    plant.question,
    thread
  );
  const override = args.values
    .get('expect')
    ?.split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  const keywords =
    plant.keywords ?? canaryKeywords(plant.fact, { exclude: [plant.question, plant.bot] });
  const match = override?.length ? 'all' : 'any';
  const expected = override?.length ? override : keywords.slice(0, CANARY_KEYWORDS_MAX);
  const { found, similarity, matchedBy } = answerRecallsCanary(answer, plant.fact, expected, match);
  const row: CanaryCheck = {
    kind: 'check',
    id,
    bot,
    plantedBy: plant.bot,
    checkedAt: new Date(now()).toISOString(),
    conversationId,
    answer,
    found,
    similarity,
    expected,
    match,
    matchedBy,
  };
  append(deps.dataDir, row);
  const anyOf = match === 'any' && expected.length > 1 ? 'any of ' : '';
  const looked = expected.length ? `expected ${anyOf}${expected.join(', ')}; ` : '';
  write(
    `${id} in ${bot}: ${found ? 'found' : 'not found'} (${looked}similarity ${similarity.toFixed(2)})`
  );
  return row;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const context = resolveCliContext(args);
  run(argv, {
    fetch,
    dataDir: cliDataDir(args.values.get('data'), context.rawConfig, context.rootDir),
  }).catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

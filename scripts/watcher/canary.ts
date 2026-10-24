#!/usr/bin/env bun
/**
 * Watcher phase 0: cross-bot recall canary.
 *
 *   bun scripts/watcher/canary.ts plant --bot <A> --fact "…" --expect <word>[,<word>] [--question "…"] [--name <display name>]
 *   bun scripts/watcher/canary.ts check --bot <B> --id <canary id> [--expect <word>[,<word>]]
 *
 * `plant` tells bot A a fact in a dashboard conversation thread and records it
 * with the distinctive word(s) the operator chose (`--expect`, required);
 * `check` asks bot B, in a thread of its own, a question that does not contain
 * the fact and records whether B's answer names ALL of those words, whole
 * word, case- and accent-insensitive (`--expect` on check overrides them; a
 * plant recorded without them needs it). No keyword is inferred from the fact:
 * every heuristic for that (rarest word, common-word list, disclaimer
 * detection) kept misjudging edge cases. Sentence `textSimilarity` is kept in
 * the row as a secondary signal only. Both rows go to
 * `<data>/watcher/canaries.jsonl`.
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
import { mentionsWord, normalizeTitle, textSimilarity } from '../../src/hygiene/text-utils';
import { fail, parseArgs, resolveCliContext } from '../system-cli';
import { cliDataDir } from './baseline';
import { url, type HttpDeps, headers } from './introspect';

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
  /** The distinctive word(s) the operator chose (`--expect`). Absent on older plants. */
  expected?: string[];
  /** The display name A was addressed by. Absent on older plants. */
  name?: string;
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
  /** The words the answer had to name, all of them (`--expect`, else the plant's). */
  expected: string[];
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

/** `--expect a,b` → `['a', 'b']`; undefined when absent or empty. */
function expectWords(raw: string | undefined): string[] | undefined {
  const words = raw
    ?.split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  return words?.length ? words : undefined;
}

/**
 * Whether an answer recalls the canary: it names every `expected` word (the
 * distinctive words the operator chose with `--expect`) as a whole word,
 * both sides normalised (`normalizeTitle`: case, accents, punctuation).
 * Nothing else decides; the sentence similarity is returned as a secondary
 * signal only.
 */
export function answerRecallsCanary(
  answer: string,
  fact: string,
  expected: string[]
): { found: boolean; similarity: number } {
  const similarity = answerSimilarity(answer, fact);
  const text = normalizeTitle(answer ?? '');
  const words = expected.map((w) => w.trim()).filter(Boolean);
  const found = words.length > 0 && words.every((w) => mentionsWord(text, normalizeTitle(w)));
  return { found, similarity };
}

/** Best sentence-level similarity of the answer to the fact (a secondary signal only). */
export function answerSimilarity(answer: string, fact: string): number {
  const sentences = (answer ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let best = 0;
  for (const s of sentences) best = Math.max(best, textSimilarity(s, fact));
  return best;
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
    throw new Error(
      'usage: canary.ts plant --bot <A> --fact "…" --expect <word> | check --bot <B> --id <id>'
    );
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
    const expected = expectWords(args.values.get('expect'));
    if (!expected) {
      throw new Error('--expect <word>[,<word>] is required: the distinctive word(s) of the fact');
    }
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
      ...(name ? { name } : {}),
      expected,
    };
    append(deps.dataDir, row);
    write(`planted ${row.id} in ${bot}`);
    return row;
  }

  const id = args.values.get('id');
  if (!id) throw new Error('--id <canary id> is required');
  const plant = findPlant(deps.dataDir, id);
  if (!plant) throw new Error(`canary ${id} not found in ${canaryPath(deps.dataDir)}`);
  const expected = expectWords(args.values.get('expect')) ?? plant.expected;
  if (!expected?.length) {
    throw new Error(
      `canary ${id} was planted without expected words: pass --expect <word>[,<word>]`
    );
  }
  const { reply: answer, conversationId } = await askInOperatorThread(
    http,
    bot,
    plant.question,
    thread
  );
  const { found, similarity } = answerRecallsCanary(answer, plant.fact, expected);
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
  };
  append(deps.dataDir, row);
  write(
    `${id} in ${bot}: ${found ? 'found' : 'not found'} (expected ${expected.join(', ')}; similarity ${similarity.toFixed(2)})`
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

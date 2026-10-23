#!/usr/bin/env bun
/**
 * Watcher phase 0: cross-bot recall canary.
 *
 *   bun scripts/watcher/canary.ts plant --bot <A> --fact "…" [--question "…"]
 *   bun scripts/watcher/canary.ts check --bot <B> --id <canary id>
 *
 * `plant` tells bot A a fact through the REST chat API (`POST /api/v1/chat/:botId`)
 * and records it; `check` asks bot B a question that does not contain the fact
 * and records whether B's answer has it (a sentence at `textSimilarity ≥ 0.6`).
 * Both rows go to `<data>/watcher/canaries.jsonl`. Expected to fail today.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { textSimilarity } from '../../src/hygiene/text-utils';
import { fail, parseArgs, resolveCliContext } from '../system-cli';
import { cliDataDir } from './baseline';
import { type HttpDeps, askBot } from './introspect';

/** A sentence of the answer at or above this similarity to the fact counts as recall. */
export const CANARY_MATCH_THRESHOLD = 0.6;
export const CANARY_CHAT_ID = 'watcher-canary';
export const DEFAULT_CANARY_QUESTION =
  'Has anyone told you a fact recently that you were asked to remember? If so, repeat it exactly in one sentence.';

export interface CanaryPlant {
  kind: 'plant';
  id: string;
  fact: string;
  question: string;
  plantedAt: string;
  bot: string;
  /** Bot A's reply, verbatim (LLM output, kept as a quoted field). */
  reply: string;
}

export interface CanaryCheck {
  kind: 'check';
  id: string;
  bot: string;
  plantedBy: string;
  checkedAt: string;
  /** Bot B's answer, verbatim (LLM output, kept as a quoted field). */
  answer: string;
  found: boolean;
  similarity: number;
}

export interface CanaryDeps extends HttpDeps {
  dataDir: string;
  now?: () => number;
  newId?: () => string;
  write?: (line: string) => void;
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
  const write = deps.write ?? ((l: string) => process.stdout.write(`${l}\n`));

  if (command === 'plant') {
    const fact = args.values.get('fact')?.trim();
    if (!fact) throw new Error('--fact "…" is required');
    const question = args.values.get('question')?.trim() || DEFAULT_CANARY_QUESTION;
    const reply = await askBot(http, bot, `Please remember this fact: ${fact}`, CANARY_CHAT_ID);
    const row: CanaryPlant = {
      kind: 'plant',
      id: deps.newId?.() ?? `c-${randomUUID().slice(0, 8)}`,
      fact,
      question,
      plantedAt: new Date(now()).toISOString(),
      bot,
      reply,
    };
    append(deps.dataDir, row);
    write(`planted ${row.id} in ${bot}`);
    return row;
  }

  const id = args.values.get('id');
  if (!id) throw new Error('--id <canary id> is required');
  const plant = findPlant(deps.dataDir, id);
  if (!plant) throw new Error(`canary ${id} not found in ${canaryPath(deps.dataDir)}`);
  const answer = await askBot(http, bot, plant.question, CANARY_CHAT_ID);
  const { found, similarity } = answerContainsFact(answer, plant.fact);
  const row: CanaryCheck = {
    kind: 'check',
    id,
    bot,
    plantedBy: plant.bot,
    checkedAt: new Date(now()).toISOString(),
    answer,
    found,
    similarity,
  };
  append(deps.dataDir, row);
  write(`${id} in ${bot}: ${found ? 'found' : 'not found'} (similarity ${similarity.toFixed(2)})`);
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

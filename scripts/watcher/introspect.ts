#!/usr/bin/env bun
/**
 * Watcher phase 0: ask a running bot what it is doing right now and score
 * the answer against its live presence.
 *
 *   bun scripts/watcher/introspect.ts --bot <id> [--url http://127.0.0.1:3000] [--token <key>] [--data <dir>]
 *
 * Reads `GET /api/agents/:id/presence` first (the truth at question time;
 * the question itself starts a conversation turn), then asks through the REST
 * chat API (`POST /api/v1/chat/:botId`, src/web/routes/chat.ts) and appends
 * one row to `<data>/watcher/introspection.jsonl`. Expected to score at
 * chance today; phase 4 reuses it for the watcher.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FieldVerdict,
  type IntrospectionTruth,
  parseIntrospectionAnswer,
  scoreIntrospection,
} from '../../src/watcher/metrics/introspection';
import { fail, parseArgs, resolveCliContext } from '../system-cli';
import { cliDataDir } from './baseline';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
/** Chat id / sender of the questions, so they land in one session per bot. */
export const INTROSPECT_CHAT_ID = 'watcher-introspect';

export const INTROSPECTION_QUESTION = [
  'Without using any tool, answer only with one JSON object describing what you are doing right now:',
  '{"phase": "start | strategist | planner | executor | idle", "tool": "<tool running now, or null>",',
  '"goal": "<id or title of the goal you are serving, or null>", "cause": "<one sentence: why, or null>"}',
].join(' ');

export interface HttpDeps {
  fetch: typeof fetch;
  baseUrl?: string;
  /** Sent as `Authorization: Bearer <token>` (multi-tenant API key). */
  token?: string;
}

export function headers(deps: HttpDeps): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (deps.token) h.Authorization = `Bearer ${deps.token}`;
  return h;
}

export function url(deps: HttpDeps, path: string): string {
  return `${(deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}${path}`;
}

/** One message through `POST /api/v1/chat/:botId`; the bot's reply. Throws on non-2xx. */
export async function askBot(
  deps: HttpDeps,
  botId: string,
  message: string,
  chatId: string
): Promise<string> {
  const res = await deps.fetch(url(deps, `/api/v1/chat/${encodeURIComponent(botId)}`), {
    method: 'POST',
    headers: headers(deps),
    body: JSON.stringify({ message, chatId, senderId: chatId, senderName: 'Watcher baseline' }),
  });
  if (!res.ok) throw new Error(`chat with ${botId} failed: HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { reply?: unknown } | null;
  if (typeof body?.reply !== 'string') throw new Error(`chat with ${botId}: no reply in response`);
  return body.reply;
}

/** `GET /api/agents/:id/presence` as a `LivePresence`. Throws on non-2xx. */
export async function fetchPresence(
  deps: HttpDeps,
  botId: string,
  nowMs: number
): Promise<IntrospectionTruth> {
  const res = await deps.fetch(url(deps, `/api/agents/${encodeURIComponent(botId)}/presence`), {
    headers: headers(deps),
  });
  if (!res.ok) throw new Error(`presence of ${botId} failed: HTTP ${res.status}`);
  const p = (await res.json().catch(() => ({}))) as {
    isExecuting?: unknown;
    phase?: unknown;
    currentTool?: unknown;
  };
  const executing = p.isExecuting === true;
  return {
    executing,
    phase: typeof p.phase === 'string' ? p.phase : null,
    currentTool: typeof p.currentTool === 'string' ? p.currentTool : null,
    // The presence payload does not carry the phase start; the read time stands in.
    since: executing ? nowMs : null,
  };
}

export interface IntrospectionRecord {
  ts: string;
  subject: string;
  question: string;
  /** The subject's reply, verbatim (LLM output, kept as a quoted field). */
  answer: string;
  parsed: boolean;
  score: number;
  fields: Record<'phase' | 'tool' | 'goal' | 'cause', FieldVerdict>;
  truth: IntrospectionTruth;
}

export interface IntrospectDeps extends HttpDeps {
  dataDir: string;
  now?: () => number;
  write?: (line: string) => void;
}

export async function run(argv: string[], deps: IntrospectDeps): Promise<IntrospectionRecord> {
  const args = parseArgs(argv);
  const botId = args.values.get('bot');
  if (!botId) throw new Error('--bot <id> is required');
  const http: HttpDeps = {
    fetch: deps.fetch,
    baseUrl: args.values.get('url') ?? deps.baseUrl,
    token: args.values.get('token') ?? deps.token,
  };
  const now = deps.now ?? Date.now;
  const write = deps.write ?? ((l: string) => process.stdout.write(`${l}\n`));

  const truth = await fetchPresence(http, botId, now());
  const answer = await askBot(http, botId, INTROSPECTION_QUESTION, INTROSPECT_CHAT_ID);
  const score = scoreIntrospection(parseIntrospectionAnswer(answer), truth);
  const row: IntrospectionRecord = {
    ts: new Date(now()).toISOString(),
    subject: `bot:${botId}`,
    question: INTROSPECTION_QUESTION,
    answer,
    parsed: score.parsed,
    score: score.score,
    fields: score.fields,
    truth,
  };
  const dir = join(deps.dataDir, 'watcher');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'introspection.jsonl'), `${JSON.stringify(row)}\n`, 'utf-8');
  write(
    `${row.subject}: score ${row.score.toFixed(2)} (parsed ${row.parsed}) ${JSON.stringify(row.fields)}`
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

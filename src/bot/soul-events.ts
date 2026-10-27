/**
 * Soul events — an append-only log of edits to a bot's memory and soul files
 * that nobody would otherwise see: memory consolidation (daily logs merged
 * into MEMORY.md), memory flushes (facts saved from a conversation) and
 * hygiene fixes. One row per edit in `<soulDir>/soul-events.jsonl`, written
 * with what the writer already knew at the time; nothing is asked of an LLM
 * afterwards. The log lives in the soul dir so it travels with a bot export
 * (the export copies the whole soul dir except `.versions/`), like
 * `goal-events.jsonl`.
 *
 * Memory contents are real user data: only short heads (≤ 120 chars, at most
 * eight per list) are stored, never whole files or messages. Logging never
 * blocks or fails the edit it describes: a failed write is reported through
 * `onError` and dropped. The file is capped (`SOUL_EVENTS_MAX_BYTES`): past
 * the cap it is rewritten with its newest half.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOUL_EVENTS_FILE = 'soul-events.jsonl';
/** Longest stored head (fact text, MEMORY.md line, fix line). */
export const SOUL_EVENT_HEAD_CHARS = 120;
/** Most heads kept per list (added, removed, detail). */
export const SOUL_EVENT_MAX_HEADS = 8;
const SUMMARY_CHARS = 240;
/** Past this size the log keeps its newest half. */
export const SOUL_EVENTS_MAX_BYTES = 512 * 1024;

/** `lesson`: a self-improvement lesson was created, proven, retired, borrowed (`src/bot/self-improve/`). */
export type SoulEventOp =
  | 'consolidate'
  | 'consolidate-rejected'
  | 'facts-saved'
  | 'hygiene-fix'
  | 'lesson';
export type SoulEventActor = 'system' | 'hygiene' | 'agent';
/** What made a memory flush run. */
export type FlushTrigger = 'proactive' | 'compaction' | 'conversation-end';

export interface SoulEvent {
  ts: string;
  /** Soul-relative file it changed (`MEMORY.md`, `memory/2026-10-11.md`), or `core-memory`. */
  file: string;
  op: SoulEventOp;
  actor: SoulEventActor;
  cycleId?: string;
  /** Session key of the conversation a flush came from. */
  conversation?: string;
  /** Hygiene run that applied the fix. */
  runId?: string;
  /** One sentence: what changed. */
  summary: string;
  /** Heads of what was added (facts saved, MEMORY.md lines new after consolidation). */
  added?: string[];
  /** Heads of what was dropped (MEMORY.md lines gone after consolidation). */
  removed?: string[];
  /** Short supporting lines: daily logs consolidated, fixes applied. */
  detail?: string[];
  /** Soul-relative path of the backup taken before the edit. */
  backup?: string;
  /** Flush only: what made it run, and why the conversation ended. */
  trigger?: FlushTrigger;
  endReason?: string;
  /** Flush only: when the conversation happened (facts are dated by it). */
  observedAt?: string;
  /** Total counts behind capped lists. */
  addedCount?: number;
  removedCount?: number;
}

export type SoulEventInput = Omit<SoulEvent, 'ts'> & {
  now?: () => Date;
  onError?: (err: unknown) => void;
  maxBytes?: number;
};

/** One line, whitespace collapsed, clipped to `max` with an ellipsis. */
export function soulEventHead(text: string, max = SOUL_EVENT_HEAD_CHARS): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function heads(list: string[] | undefined): string[] | undefined {
  if (!list) return undefined;
  const out = list
    .map((t) => soulEventHead(t))
    .filter(Boolean)
    .slice(0, SOUL_EVENT_MAX_HEADS);
  return out.length > 0 ? out : undefined;
}

function rotate(path: string, maxBytes: number): void {
  if (statSync(path).size <= maxBytes) return;
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  let kept = lines.slice(Math.floor(lines.length / 2));
  // A tiny cap with long rows: keep dropping the oldest until it fits.
  while (kept.length > 1 && Buffer.byteLength(`${kept.join('\n')}\n`) > maxBytes) {
    kept = kept.slice(1);
  }
  writeFileSync(path, `${kept.join('\n')}\n`, 'utf-8');
}

/** Append one event. Never throws. */
export function appendSoulEvent(soulDir: string, input: SoulEventInput): void {
  const { now, onError, maxBytes, ...fields } = input;
  try {
    const event: SoulEvent = {
      ts: (now ?? (() => new Date()))().toISOString(),
      file: fields.file,
      op: fields.op,
      actor: fields.actor,
      summary: soulEventHead(fields.summary, SUMMARY_CHARS),
    };
    for (const key of [
      'cycleId',
      'conversation',
      'runId',
      'backup',
      'trigger',
      'endReason',
      'observedAt',
    ] as const) {
      const v = fields[key];
      if (v) (event as unknown as Record<string, unknown>)[key] = v;
    }
    for (const key of ['added', 'removed', 'detail'] as const) {
      const v = heads(fields[key]);
      if (v) event[key] = v;
    }
    if (typeof fields.addedCount === 'number') event.addedCount = fields.addedCount;
    if (typeof fields.removedCount === 'number') event.removedCount = fields.removedCount;
    const path = join(soulDir, SOUL_EVENTS_FILE);
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf-8');
    rotate(path, maxBytes ?? SOUL_EVENTS_MAX_BYTES);
  } catch (err) {
    onError?.(err);
  }
}

/** A bot's soul events, oldest first; `limit` keeps the newest. Malformed lines are skipped. */
export function readSoulEvents(soulDir: string, opts: { limit?: number } = {}): SoulEvent[] {
  const path = join(soulDir, SOUL_EVENTS_FILE);
  if (!existsSync(path)) return [];
  const out: SoulEvent[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SoulEvent;
      if (e && typeof e.op === 'string' && typeof e.ts === 'string') out.push(e);
    } catch {
      // skip
    }
  }
  return opts.limit && opts.limit > 0 ? out.slice(-opts.limit) : out;
}

const CONSOLIDATION_HEADER = /^<!--\s*last-consolidated:/;

function meaningfulLines(text: string | null): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !CONSOLIDATION_HEADER.test(l));
}

/** Lines of `after` not in `before`, and lines of `before` not in `after` (order kept). */
export function diffLines(
  before: string | null,
  after: string
): { added: string[]; removed: string[] } {
  const prev = meaningfulLines(before);
  const next = meaningfulLines(after);
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  return {
    added: next.filter((l) => !prevSet.has(l)),
    removed: prev.filter((l) => !nextSet.has(l)),
  };
}

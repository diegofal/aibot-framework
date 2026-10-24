/**
 * What the watcher's model saw and said (plan
 * `docs/plans/watcher-optimizations-plan.md`, O6: "ground truth is the
 * record"). The query log keeps tokens and cost; this keeps the prompt and
 * the response of every notice / integrate / introspect call, one file per
 * call: `<watcherDir>/passes/<tier>-<endedMs>-<rand>.json`.
 *
 * Redacted like the tool audit: every prompt line is clipped to
 * `PASS_RECORD_LINE_MAX` (300) chars (an event item, operator text included,
 * is one line), the prompt and the response are capped as a whole. Retention:
 * 14 days and at most 500 files, pruned on write. Writing never throws;
 * readers never throw.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '../ollama';
import type { WatcherTier } from './budget';

export const PASS_RECORD_LINE_MAX = 300;
export const PASS_RECORD_PROMPT_MAX = 60_000;
export const PASS_RECORD_RESPONSE_MAX = 20_000;
export const PASS_RECORD_RETENTION_MS = 14 * 86_400_000;
export const PASS_RECORD_MAX_FILES = 500;
const MAX_CYCLE_REFS = 20;

const ID_RE = /^[a-z]+-\d{1,15}-[0-9a-f]{4}$/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export interface PassRecord {
  id: string;
  caller: `watcher:${string}`;
  tier: WatcherTier;
  startedAt: string;
  endedAt: string;
  ok: boolean;
  model: string;
  backend: string;
  durationMs: number;
  tokens?: number;
  costUsd?: number;
  /** Redacted: lines clipped, the whole capped. */
  prompt: { system: string; user: string };
  response?: string;
  error?: string;
  /** Cycle ids the prompt names (the cycles the pass read about). */
  refs?: { cycleIds: string[] };
}

export type PassRecordInput = Omit<PassRecord, 'id' | 'startedAt' | 'endedAt' | 'refs'>;

/** What `GET /api/watcher/passes` lists: a record without its prompt and response. */
export type PassRecordSummary = Omit<PassRecord, 'prompt' | 'response'> & {
  promptChars: number;
  responseChars: number;
};

export function passesDir(watcherDir: string): string {
  return join(watcherDir, 'passes');
}

export function isPassRecordId(id: string): boolean {
  return ID_RE.test(id);
}

function clipLine(line: string): string {
  return line.length > PASS_RECORD_LINE_MAX ? `${line.slice(0, PASS_RECORD_LINE_MAX)}…` : line;
}

function clipText(text: string, max: number, lines = true): string {
  const t = lines ? text.split('\n').map(clipLine).join('\n') : text;
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more chars)` : t;
}

/** The messages of a call as `{ system, user }` (the rest joined), every line clipped. Pure. */
export function redactPassPrompt(messages: ChatMessage[]): PassRecord['prompt'] {
  const text = (m: ChatMessage) => (typeof m.content === 'string' ? m.content : '');
  const system = messages.filter((m) => m.role === 'system').map(text);
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => (m.role === 'user' ? text(m) : `[${m.role}]\n${text(m)}`));
  return {
    system: clipText(system.join('\n\n'), PASS_RECORD_PROMPT_MAX),
    user: clipText(rest.join('\n\n'), PASS_RECORD_PROMPT_MAX),
  };
}

function cycleRefs(prompt: PassRecord['prompt']): string[] {
  const ids = new Set<string>();
  for (const m of prompt.user.matchAll(UUID_RE)) {
    ids.add(m[0].toLowerCase());
    if (ids.size >= MAX_CYCLE_REFS) break;
  }
  return [...ids];
}

const endedMsOf = (file: string) => Number(file.split('-')[1]);

export interface PassRecordsOptions {
  dir: string;
  now?: () => number;
  retentionMs?: number;
  maxFiles?: number;
  logger?: { warn: (obj: object, msg: string) => void };
}

export class PassRecords {
  private readonly now: () => number;

  constructor(private readonly opts: PassRecordsOptions) {
    this.now = opts.now ?? Date.now;
  }

  get dir(): string {
    return this.opts.dir;
  }

  /** One file for one call; returns its id, or undefined when the write failed. Never throws. */
  write(input: PassRecordInput): string | undefined {
    try {
      const ended = this.now();
      const short = input.caller.replace(/^watcher:/, '').replace(/[^a-z]/g, '') || 'call';
      const id = `${short}-${ended}-${randomBytes(2).toString('hex')}`;
      const prompt = {
        system: clipText(input.prompt.system, PASS_RECORD_PROMPT_MAX),
        user: clipText(input.prompt.user, PASS_RECORD_PROMPT_MAX),
      };
      const refs = cycleRefs(prompt);
      const record: PassRecord = {
        ...input,
        id,
        startedAt: new Date(ended - Math.max(0, input.durationMs)).toISOString(),
        endedAt: new Date(ended).toISOString(),
        prompt,
        ...(input.response !== undefined
          ? { response: clipText(input.response, PASS_RECORD_RESPONSE_MAX, false) }
          : {}),
        ...(refs.length ? { refs: { cycleIds: refs } } : {}),
      };
      mkdirSync(this.opts.dir, { recursive: true });
      writeFileSync(join(this.opts.dir, `${id}.json`), JSON.stringify(record), 'utf-8');
      this.prune();
      return id;
    } catch (err) {
      this.opts.logger?.warn({ err, dir: this.opts.dir }, 'Watcher: failed to keep a pass record');
      return undefined;
    }
  }

  /** Drop files past retention, then the oldest beyond the cap. Never throws. */
  prune(): void {
    try {
      const cutoff = this.now() - (this.opts.retentionMs ?? PASS_RECORD_RETENTION_MS);
      const files = this.files();
      const keep: string[] = [];
      for (const f of files) {
        if (endedMsOf(f) < cutoff) rmSync(join(this.opts.dir, f), { force: true });
        else keep.push(f);
      }
      const max = this.opts.maxFiles ?? PASS_RECORD_MAX_FILES;
      for (const f of keep.slice(0, Math.max(0, keep.length - max))) {
        rmSync(join(this.opts.dir, f), { force: true });
      }
    } catch {
      // pruning is best-effort
    }
  }

  get(id: string): PassRecord | undefined {
    if (!isPassRecordId(id)) return undefined;
    try {
      return JSON.parse(readFileSync(join(this.opts.dir, `${id}.json`), 'utf-8')) as PassRecord;
    } catch {
      return undefined;
    }
  }

  /** Newest first, without prompt and response. */
  list(limit = 50): PassRecordSummary[] {
    const out: PassRecordSummary[] = [];
    for (const f of this.files().reverse()) {
      if (out.length >= limit) break;
      const rec = this.get(f.slice(0, -'.json'.length));
      if (!rec) continue;
      const { prompt, response, ...rest } = rec;
      out.push({
        ...rest,
        promptChars: (prompt?.system?.length ?? 0) + (prompt?.user?.length ?? 0),
        responseChars: response?.length ?? 0,
      });
    }
    return out;
  }

  /** Record file names, oldest first (by the end time in the name). */
  private files(): string[] {
    try {
      return readdirSync(this.opts.dir)
        .filter((f) => f.endsWith('.json') && isPassRecordId(f.slice(0, -5)))
        .sort((a, b) => endedMsOf(a) - endedMsOf(b) || a.localeCompare(b));
    } catch {
      return [];
    }
  }
}

const shared = new Map<string, PassRecords>();

/** The records of a watcher dir (one instance per dir per process). */
export function passRecordsFor(watcherDir: string): PassRecords {
  const dir = passesDir(watcherDir);
  let r = shared.get(dir);
  if (!r) {
    r = new PassRecords({ dir });
    shared.set(dir, r);
  }
  return r;
}

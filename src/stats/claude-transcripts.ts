/**
 * Cost history from the Claude CLI's transcripts. Every `claude -p` run leaves
 * `<CLAUDE_CONFIG_DIR>/projects/-tmp/<session>.jsonl` with a `cost-state` line:
 * the cost the CLI computed, the start time and the tokens per model with the
 * prompt cache. The query log recorded neither cost nor cache tokens before
 * 2026-10-15; `scripts/usage/backfill-claude-costs.ts` matches each session to
 * the call that made it (by time) and writes them into the entry. Pure.
 */
import type { LlmQueryEntry } from '../bot/llm-query-log';

export interface TranscriptSession {
  sessionId: string;
  startMs: number;
  costUsd: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** `name:` of the "## Agent identity" block in the prompt, when there is one. */
  agentName?: string;
}

interface CostState {
  type: 'cost-state';
  sessionId?: string;
  totalCostUSD?: number;
  startTime?: number;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
}

const AGENT_NAME = /## Agent identity\s*\\?n?\s*name:\s*([^\n\\]+)/;

export function parseTranscript(text: string): TranscriptSession | null {
  let state: CostState | null = null;
  let agentName: string | undefined;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (!agentName && line.includes('## Agent identity')) {
      try {
        const o = JSON.parse(line) as { content?: unknown; message?: { content?: unknown } };
        const content =
          typeof o.content === 'string' ? o.content : String(o.message?.content ?? '');
        const m = /## Agent identity\s*\n\s*name:\s*([^\n]+)/.exec(content);
        if (m) agentName = m[1].trim();
      } catch {
        const m = AGENT_NAME.exec(line);
        if (m) agentName = m[1].trim();
      }
    }
    if (line.includes('"cost-state"')) {
      try {
        const o = JSON.parse(line) as CostState;
        if (o.type === 'cost-state') state = o;
      } catch {
        /* torn line */
      }
    }
  }
  if (!state || typeof state.startTime !== 'number' || !state.sessionId) return null;
  const usage = Object.entries(state.modelUsage ?? {});
  const sum = (
    k: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
  ) => usage.reduce((acc, [, u]) => acc + (u[k] ?? 0), 0);
  return {
    sessionId: state.sessionId,
    startMs: state.startTime,
    costUsd: state.totalCostUSD ?? 0,
    ...(usage[0] ? { model: usage[0][0] } : {}),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadInputTokens'),
    cacheCreationTokens: sum('cacheCreationInputTokens'),
    ...(agentName ? { agentName } : {}),
  };
}

/** Before the logged start (queue, clock skew) and after the logged end a session may still belong to the call. */
const LEAD_MS = 5_000;
const TAIL_MS = 2_000;

/**
 * Each session goes to the claude-cli call whose run `[end - duration, end]`
 * (widened by LEAD/TAIL) contains its start; when several do, the one whose
 * start is nearest. Entries that already carry a cost are left alone.
 */
export function matchSessions(
  entries: LlmQueryEntry[],
  sessions: TranscriptSession[]
): { byEntry: Map<number, TranscriptSession[]>; unmatched: TranscriptSession[] } {
  const windows = entries
    .map((e, i) => {
      const end = Date.parse(e.timestamp);
      const start = end - (Number(e.durationMs) || 0);
      return { i, start, end, ok: e.backend === 'claude-cli' && e.costUsd === undefined };
    })
    .filter((w) => w.ok && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start);
  const byEntry = new Map<number, TranscriptSession[]>();
  const unmatched: TranscriptSession[] = [];
  for (const s of [...sessions].sort((a, b) => a.startMs - b.startMs)) {
    let best: (typeof windows)[number] | null = null;
    for (const w of windows) {
      if (w.start - LEAD_MS > s.startMs) break;
      if (s.startMs > w.end + TAIL_MS) continue;
      if (!best || Math.abs(w.start - s.startMs) < Math.abs(best.start - s.startMs)) best = w;
    }
    if (best) {
      const list = byEntry.get(best.i) ?? [];
      list.push(s);
      byEntry.set(best.i, list);
    } else unmatched.push(s);
  }
  return { byEntry, unmatched };
}

export type BackfilledEntry = LlmQueryEntry & { sessionIds?: string[]; backfilled?: boolean };

/** Entries with their matched sessions' cost and cache tokens; the rest unchanged. */
export function enrichEntries(
  entries: LlmQueryEntry[],
  byEntry: Map<number, TranscriptSession[]>
): BackfilledEntry[] {
  return entries.map((e, i) => {
    const s = byEntry.get(i);
    if (!s || s.length === 0) return e;
    return {
      ...e,
      costUsd: s.reduce((a, x) => a + x.costUsd, 0),
      cacheReadTokens: s.reduce((a, x) => a + x.cacheReadTokens, 0),
      cacheCreationTokens: s.reduce((a, x) => a + x.cacheCreationTokens, 0),
      sessionIds: s.map((x) => x.sessionId),
      backfilled: true,
    };
  });
}

/**
 * Per-cycle records the agent loop appends to
 * `<data>/agent-cycles/<botId>/YYYY-MM-DD.jsonl` (cycle id, plan, the goal it
 * served). Read-only; never throws, never creates the dir. Data written before
 * the agent loop recorded cycles simply is not there.
 */
import { join } from 'node:path';
import { dateKey, listDirSafe, readJsonlSafe, toMs } from '../util';

export interface AgentCycleRecord {
  cycleId: string;
  botId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status?: string;
  focus?: string | null;
  planSummary?: string | null;
  plan?: unknown;
  priority?: string | null;
  toolCalls?: number;
  tools?: string[];
  goalId?: string | null;
  goalTitle?: string | null;
  goalSource?: string | null;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

export function readAgentCycles(
  baseDir: string,
  botId: string,
  sinceMs: number,
  nowMs: number
): AgentCycleRecord[] {
  const botDir = join(baseDir, botId);
  const minKey = dateKey(Math.max(0, sinceMs - DAY_MS));
  const maxKey = dateKey(nowMs + DAY_MS);
  const out: AgentCycleRecord[] = [];
  const files = listDirSafe(botDir)
    .filter((name) => {
      const m = DAY_FILE.exec(name);
      return m !== null && m[1] >= minKey && m[1] <= maxKey;
    })
    .sort();
  for (const name of files) {
    for (const row of readJsonlSafe<AgentCycleRecord>(join(botDir, name))) {
      const t = toMs(row?.startedAt);
      if (!row?.cycleId || t === null || t < sinceMs || t > nowMs + DAY_MS) continue;
      out.push(row);
    }
  }
  return out.sort((a, b) => (toMs(a.startedAt) ?? 0) - (toMs(b.startedAt) ?? 0));
}

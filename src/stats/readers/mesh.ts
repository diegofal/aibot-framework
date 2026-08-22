import type { KnowledgeEntry } from '../../bot/knowledge-mesh';
import { readJsonlSafe, toMs } from '../util';

export interface MeshCounts {
  byBot: Record<string, number>;
  total: number;
}

/** Insights published to `shared/knowledge-mesh.jsonl` inside the window, per source bot. */
export function readMeshCounts(meshPath: string, sinceMs: number): MeshCounts {
  const byBot: Record<string, number> = {};
  let total = 0;
  for (const e of readJsonlSafe<KnowledgeEntry>(meshPath)) {
    const t = toMs(e.timestamp);
    if (t !== null && t < sinceMs) continue;
    const bot = e.sourceBotId || 'unknown';
    byBot[bot] = (byBot[bot] ?? 0) + 1;
    total++;
  }
  return { byBot, total };
}

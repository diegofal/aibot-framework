import { join } from 'node:path';
import { getStatsFromEntries, readEntries } from '../../productions/changelog';
import type { ProductionEntry } from '../../productions/types';
import { toMs } from '../util';

export interface ProductionOutput {
  filesActive: number;
  filesArchived: number;
  approved: number;
  rejected: number;
  unreviewed: number;
  lastFileAt: string | null;
}

const EMPTY: ProductionOutput = {
  filesActive: 0,
  filesArchived: 0,
  approved: 0,
  rejected: 0,
  unreviewed: 0,
  lastFileAt: null,
};

/**
 * Replay `changelog.jsonl` to learn which production files are still live,
 * which were archived, and how the content entries were reviewed.
 *
 * Review counts (approved / rejected / unreviewed) are computed over the
 * content entries only (`create` / `edit`) — archive and delete records
 * never carry an evaluation and would inflate `unreviewed`.
 */
export function readProductionOutput(workDir: string): ProductionOutput {
  let entries: ProductionEntry[];
  try {
    entries = readEntries(join(workDir, 'changelog.jsonl'));
  } catch {
    return { ...EMPTY };
  }
  if (entries.length === 0) return { ...EMPTY };

  const sorted = [...entries].sort((a, b) => (toMs(a.timestamp) ?? 0) - (toMs(b.timestamp) ?? 0));
  const active = new Set<string>();
  const archived = new Set<string>();
  const content: ProductionEntry[] = [];
  let lastFileMs: number | null = null;

  for (const e of sorted) {
    switch (e.action) {
      case 'create':
      case 'edit': {
        active.add(e.path);
        content.push(e);
        const t = toMs(e.timestamp);
        if (t !== null && (lastFileMs === null || t > lastFileMs)) lastFileMs = t;
        break;
      }
      case 'archive': {
        const from = e.archivedFrom ?? e.path;
        active.delete(from);
        archived.add(from);
        break;
      }
      case 'delete':
        active.delete(e.path);
        break;
      default:
        break;
    }
  }

  const review = getStatsFromEntries(content);
  return {
    filesActive: active.size,
    filesArchived: archived.size,
    approved: review.approved,
    rejected: review.rejected,
    unreviewed: review.unreviewed,
    lastFileAt: lastFileMs === null ? null : new Date(lastFileMs).toISOString(),
  };
}

/** Content entries (`create` / `edit`) recorded strictly after `sinceMs`. */
export function countContentEntriesSince(workDir: string, sinceMs: number): number {
  let entries: ProductionEntry[];
  try {
    entries = readEntries(join(workDir, 'changelog.jsonl'));
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (e.action !== 'create' && e.action !== 'edit') continue;
    const t = toMs(e.timestamp);
    if (t !== null && t > sinceMs) n++;
  }
  return n;
}

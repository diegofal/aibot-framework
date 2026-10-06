import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getStatsFromEntries, pendingFiles, readEntries } from '../../productions/changelog';
import { isUntrackedProductionPath, normalizeEntryPath } from '../../productions/paths';
import type { ProductionEntry } from '../../productions/types';
import { toMs } from '../util';

export interface ProductionOutput {
  filesActive: number;
  filesArchived: number;
  approved: number;
  rejected: number;
  /** Files waiting on a first review — same definition as Needs You (`pendingFiles`). */
  unreviewed: number;
  /** Files approved/rejected before that the bot edited since; not counted in `unreviewed`. */
  editedSinceReview: number;
  lastFileAt: string | null;
}

const EMPTY: ProductionOutput = {
  filesActive: 0,
  filesArchived: 0,
  approved: 0,
  rejected: 0,
  unreviewed: 0,
  editedSinceReview: 0,
  lastFileAt: null,
};

/**
 * Replay `changelog.jsonl` to learn which production files are still live,
 * which were archived, and how the content entries were reviewed.
 *
 * `approved` / `rejected` count content rows (`create` / `edit`) with that
 * verdict. `unreviewed` / `editedSinceReview` count *files*, via `pendingFiles`
 * plus the on-disk check Needs You does, so the Stats KPI, Agent Home and Fleet
 * Home say the same number as the queue. Bookkeeping files and `archived/**`
 * are never outputs.
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
        if (isUntrackedProductionPath(normalizeEntryPath(workDir, e.path))) break;
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
  let unreviewed = 0;
  let editedSinceReview = 0;
  for (const p of pendingFiles(entries, (path) => normalizeEntryPath(workDir, path))) {
    if (!p.entry.trackOnly && !existsSync(join(workDir, p.key))) continue;
    if (p.priorVerdict) editedSinceReview++;
    else unreviewed++;
  }
  return {
    filesActive: active.size,
    filesArchived: archived.size,
    approved: review.approved,
    rejected: review.rejected,
    unreviewed,
    editedSinceReview,
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

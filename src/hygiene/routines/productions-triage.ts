/**
 * productions-triage — report on a bot's productions directory.
 *
 * Reuses src/productions: changelog readers, `analyzeCleanup` (pure) and
 * `archiveFile` (moves into archived/, never deletes). Apply archives
 * `unreviewed-stale` findings only when `options.archiveStale === true`, and
 * prunes `orphan-reference` changelog lines only when
 * `options.pruneOrphans === true` — after backing the changelog up.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEntry, readEntries } from '../../productions/changelog';
import { analyzeCleanup } from '../../productions/cleanup';
import { archiveFile } from '../../productions/files';
import { INDEX_EXCLUDES, assertWithinDir } from '../../productions/paths';
import type { ProductionEntry } from '../../productions/types';
import { assertWithinRoots, backupFile } from '../fs-safe';
import { daysBetween } from '../text-utils';
import type { HygieneApplyResult, HygieneContext, HygieneFinding, HygieneRoutine } from '../types';

const DEFAULT_STALE_DAYS = 7;
const NUMBER_PREFIX_RE = /^(\d{2})_/;
const CHANGELOG = 'changelog.jsonl';
/** Bookkeeping actions whose entry is *about* a path no longer being there. */
const HISTORY_ACTIONS = new Set(['archive', 'delete']);

/** Latest non-archive entry per path (entries are append-only). */
function latestByPath(entries: ProductionEntry[]): Map<string, ProductionEntry> {
  const map = new Map<string, ProductionEntry>();
  for (const e of entries) {
    // `infra`/note entries carry no path; they are bookkeeping, not files.
    if (typeof e.path !== 'string' || !e.path) continue;
    if (e.action === 'archive') {
      if (e.archivedFrom) map.delete(e.archivedFrom);
      continue;
    }
    if (e.action === 'delete') {
      map.delete(e.path);
      continue;
    }
    map.set(e.path, e);
  }
  return map;
}

function rootFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !INDEX_EXCLUDES.has(name))
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Should this raw changelog line be dropped for one of `targets`?
 *
 * Conservative by construction — anything that is not provably a dangling
 * reference to a missing file inside `dir` is kept:
 *   - unparseable lines (a stray markdown line in the JSONL) stay,
 *   - entries without a path stay (`infra`/note bookkeeping),
 *   - `trackOnly` entries stay (they live in their natural location),
 *   - `archive`/`delete` entries stay (they are the record of the removal),
 *   - paths outside `dir` stay (untracked, not orphaned),
 *   - paths that exist on disk again stay (the file came back since preview).
 */
function isPrunableLine(line: string, targets: Set<string>, dir: string): ProductionEntry | null {
  let entry: ProductionEntry;
  try {
    entry = JSON.parse(line) as ProductionEntry;
  } catch {
    return null;
  }
  if (typeof entry?.path !== 'string' || !entry.path) return null;
  if (!targets.has(entry.path)) return null;
  if (entry.trackOnly) return null;
  if (HISTORY_ACTIONS.has(entry.action)) return null;
  if (!assertWithinDir(dir, entry.path)) return null;
  if (existsSync(join(dir, entry.path))) return null;
  return entry;
}

/**
 * Rewrite changelog.jsonl without the entries of the orphaned paths.
 *
 * The file is backed up first (fs-safe `backupFile` → `<dir>/.versions/
 * changelog.jsonl.<ISO>.bak`) and the surviving lines are written back
 * verbatim — the raw JSON text, in the original order — so a prune can never
 * reformat or reorder history it did not remove.
 */
function pruneOrphanEntries(
  ctx: HygieneContext,
  dir: string,
  orphans: HygieneFinding[],
  result: HygieneApplyResult
): void {
  const changelogPath = join(dir, CHANGELOG);
  if (!existsSync(changelogPath)) {
    for (const f of orphans)
      result.skipped.push({ findingId: f.id, reason: `${CHANGELOG} missing` });
    return;
  }
  assertWithinRoots(changelogPath, ctx.allowedRoots);

  const targets = new Set(orphans.map((f) => f.file as string));
  const removedByPath = new Map<string, number>();
  const kept: string[] = [];

  for (const line of readFileSync(changelogPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const pruned = isPrunableLine(line, targets, dir);
    if (!pruned) {
      kept.push(line);
      continue;
    }
    removedByPath.set(pruned.path, (removedByPath.get(pruned.path) ?? 0) + 1);
  }

  if (removedByPath.size > 0) {
    const backup = backupFile(changelogPath, ctx.logger, ctx.now);
    if (backup) result.backups.push(backup);
    writeFileSync(changelogPath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf-8');
  }

  for (const f of orphans) {
    const removed = removedByPath.get(f.file as string) ?? 0;
    if (removed === 0) {
      result.skipped.push({ findingId: f.id, reason: 'no changelog entry left to prune' });
      continue;
    }
    result.applied.push({
      findingId: f.id,
      action: 'prune-changelog',
      result: `${removed} changelog ${removed === 1 ? 'entry' : 'entries'} for ${f.file} removed`,
    });
  }
}

export const productionsTriage: HygieneRoutine = {
  id: 'productions-triage',
  name: 'Productions triage',
  description:
    'Lists stale unreviewed productions, duplicate numbering, changelog entries pointing at missing files, unnumbered root files and auto-cleanup candidates.',
  scope: 'bot',
  canApply: true,

  preview(ctx: HygieneContext): HygieneFinding[] {
    const findings: HygieneFinding[] = [];
    const dir = ctx.workDir;
    if (!dir || !ctx.botId || !existsSync(dir)) return findings;

    const staleDays =
      Number(ctx.options.staleDays) > 0 ? Number(ctx.options.staleDays) : DEFAULT_STALE_DAYS;
    const entries = readEntries(join(dir, CHANGELOG));
    const latest = latestByPath(entries);

    for (const [path, e] of latest) {
      if (e.trackOnly) continue;
      // A path outside the productions dir is untracked bookkeeping, not an
      // orphan we may rewrite — report it, never offer to prune it.
      const within = assertWithinDir(dir, path);
      const exists = within && existsSync(join(dir, path));
      if (!exists) {
        findings.push({
          id: `productions-triage:orphan-reference:${path}`,
          kind: 'orphan-reference',
          severity: 'warn',
          file: path,
          line: null,
          message: within
            ? `changelog references ${path} but the file no longer exists`
            : `changelog references ${path}, which is outside the productions dir`,
          fixable: within,
          ...(within
            ? {
                fix: {
                  action: 'prune-changelog',
                  details: `Drop the ${CHANGELOG} entries for this path (requires options.pruneOrphans=true)`,
                },
              }
            : {}),
          data: { entryId: e.id },
        });
        continue;
      }
      const age = daysBetween(new Date(e.timestamp), ctx.now);
      if (!e.evaluation?.status && age > staleDays) {
        findings.push({
          id: `productions-triage:unreviewed-stale:${path}`,
          kind: 'unreviewed-stale',
          severity: 'info',
          file: path,
          line: null,
          message: `${path} has been unreviewed for ${age} days`,
          fixable: true,
          fix: {
            action: 'archive',
            details: 'Move to archived/ (requires options.archiveStale=true)',
          },
          data: { entryId: e.id, ageDays: age },
        });
      }
    }

    const files = rootFiles(dir);
    const byNumber = new Map<string, string[]>();
    for (const name of files) {
      const m = name.match(NUMBER_PREFIX_RE);
      if (m) {
        const list = byNumber.get(m[1]) ?? [];
        list.push(name);
        byNumber.set(m[1], list);
      } else if (name.endsWith('.md')) {
        findings.push({
          id: `productions-triage:unnumbered:${name}`,
          kind: 'unnumbered',
          severity: 'info',
          file: name,
          line: null,
          message: `${name} has no NN_ prefix`,
          fixable: false,
        });
      }
    }
    for (const [num, names] of byNumber) {
      if (names.length < 2) continue;
      findings.push({
        id: `productions-triage:duplicate-number:${num}`,
        kind: 'duplicate-number',
        severity: 'warn',
        file: names[0],
        line: null,
        message: `Number ${num}_ is shared by ${names.join(', ')}`,
        fixable: false,
        data: { files: names },
      });
    }

    for (const c of analyzeCleanup({
      dir,
      now: ctx.now.getTime(),
      coherenceCheck: () => ({ coherent: true, issues: [] }),
    })) {
      findings.push({
        id: `productions-triage:cleanup-candidate:${c.path}`,
        kind: 'cleanup-candidate',
        severity: 'info',
        file: c.path,
        line: null,
        message: `${c.path}: ${c.reason}`,
        fixable: false,
      });
    }

    return findings;
  },

  apply(ctx: HygieneContext, findings: HygieneFinding[]): HygieneApplyResult {
    const result: HygieneApplyResult = { applied: [], skipped: [], backups: [] };
    const dir = ctx.workDir;
    const archiveStale = ctx.options.archiveStale === true;
    const pruneOrphans = ctx.options.pruneOrphans === true;
    const orphans: HygieneFinding[] = [];

    for (const f of findings) {
      if (f.kind === 'orphan-reference') {
        if (pruneOrphans && f.fixable && f.file && dir && ctx.botId) {
          orphans.push(f);
        } else {
          result.skipped.push({ findingId: f.id, reason: 'report only' });
        }
        continue;
      }
      if (f.kind !== 'unreviewed-stale' || !f.fixable || !f.file) {
        result.skipped.push({ findingId: f.id, reason: 'report only' });
        continue;
      }
      if (!archiveStale) {
        result.skipped.push({
          findingId: f.id,
          reason: 'pass options.archiveStale=true to archive',
        });
        continue;
      }
      if (!dir || !ctx.botId) {
        result.skipped.push({ findingId: f.id, reason: 'no productions dir' });
        continue;
      }
      assertWithinRoots(join(dir, f.file), ctx.allowedRoots);
      const archived = archiveFile(
        { dir },
        f.file,
        `productions-triage: unreviewed for ${f.data?.ageDays ?? '?'} days`
      );
      if (!archived.ok) {
        result.skipped.push({
          findingId: f.id,
          reason: 'archive failed (missing file or invalid path)',
        });
        continue;
      }
      appendEntry(join(dir, CHANGELOG), { ...archived.entry, botId: ctx.botId });
      result.applied.push({ findingId: f.id, action: 'archive', result: `${f.file} → archived/` });
    }

    if (orphans.length > 0 && dir) pruneOrphanEntries(ctx, dir, orphans, result);

    return result;
  },
};

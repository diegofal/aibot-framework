/**
 * Tree — directory walking for the productions index.
 *
 * Extracts the directory walk from ProductionsService.getDirectoryTree.
 * Per docs/architecture-docs/productions-refactor.md §6:
 *   - walkTree({dir, entryMap, excludes}) → TreeNode[]
 *   - Walks the directory tree starting at `dir`. For each file node,
 *     enriches with the ProductionEntry's metadata (entryId,
 *     description, evaluation, coherenceCheck) from entryMap.
 *   - Skips entries whose name is in `excludes` at every level.
 *   - Returns [] when the root directory does not exist.
 *
 * Module boundary:
 *   - I/O: readdirSync + statSync. Returns pure data (TreeNode[]).
 *   - No facade, no logger, no config. Just dir + entryMap + excludes.
 *
 * Consumed by ProductionsService.getDirectoryTree (via thin wrapper).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readEntries as readEntriesPure } from './changelog';
import type { ProductionEntry, TreeNode } from './types';

export interface WalkTreeContext {
  /** Absolute path to the root directory. */
  dir: string;
  /** Map from relative path → newest changelog entry. */
  entryMap: Map<string, ProductionEntry>;
  /** Entry names to skip at every level (e.g. changelog.jsonl, index.html). */
  excludes: Set<string>;
}

/**
 * Walk the directory tree starting at ctx.dir, returning TreeNode[].
 *
 * Pure I/O. Returns [] when the root directory does not exist.
 * Files are sorted alphabetically at each level. Directory nodes have
 * no entryId/description/etc (only file nodes get enriched).
 */
export function walkTree(ctx: WalkTreeContext): TreeNode[] {
  if (!existsSync(ctx.dir)) return [];

  const walk = (current: string, relPrefix: string): TreeNode[] => {
    let dirEntries: string[];
    try {
      dirEntries = readdirSync(current);
    } catch {
      return [];
    }

    const nodes: TreeNode[] = [];

    for (const name of dirEntries.sort()) {
      if (ctx.excludes.has(name)) continue;
      const fullPath = join(current, name);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      const relPath = relPrefix ? `${relPrefix}/${name}` : name;

      if (stat.isDirectory()) {
        const children = walk(fullPath, relPath);
        nodes.push({ name, path: relPath, type: 'dir', children });
      } else {
        const node: TreeNode = { name, path: relPath, type: 'file', size: stat.size };
        const entry = ctx.entryMap.get(relPath);
        if (entry) {
          node.entryId = entry.id;
          node.description = entry.description;
          if (entry.evaluation) {
            node.evaluation = {
              status: entry.evaluation.status,
              rating: entry.evaluation.rating,
            };
          }
          if (entry.coherenceCheck) {
            node.coherenceCheck = { coherent: entry.coherenceCheck.coherent };
          }
        }
        nodes.push(node);
      }
    }

    return nodes;
  };

  return walk(ctx.dir, '');
}

/**
 * Build a Map<relativePath, ProductionEntry> from a bot's changelog.jsonl.
 *
 * - Skips entries whose path is absolute (read-dead and write-dead).
 * - Keeps the newest entry per path (later lines in the JSONL win).
 *
 * Companion to walkTree. I/O.
 */
export function buildEntryMap(dir: string): Map<string, ProductionEntry> {
  const changelogPath = join(dir, 'changelog.jsonl');
  const entries = readEntriesPure(changelogPath);
  const map = new Map<string, ProductionEntry>();
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || isAbsolute(entry.path)) continue;
    map.set(entry.path, entry);
  }
  return map;
}

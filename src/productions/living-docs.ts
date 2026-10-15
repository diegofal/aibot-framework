/**
 * Living documents: in an agent-loop cycle each goal keeps ONE document in
 * productions, updated in place and kept short, and explore cycles write to
 * memory, not to productions. Bots used to start a new file every cycle
 * ("ONE concrete deliverable per session"): live, jarvis-factory had 12 files
 * for one research thread and job-seeker a new "swe_trends" file each day.
 *
 * Applies to write-ups only (`isDocumentPath`): code, data and scratch files
 * (`_x`) are supporting work and never refused. Pure; the executor supplies
 * the changelog and file access (`livingDocRefusal`).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isScratchProductionPath, isUntrackedProductionPath } from './paths';
import type { ProductionEntry } from './types';

/** About two pages: room for a full design, still a limit that forces consolidation. */
export const LIVING_DOC_DEFAULTS = { enabled: true, maxChars: 12000 } as const;

const DOCUMENT_EXT = /\.(md|markdown|html?|txt)$/i;

/** A write-up the operator reads: markdown, html or text, not scratch, not bookkeeping, not archived. */
export function isDocumentPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return DOCUMENT_EXT.test(p) && !isScratchProductionPath(p) && !isUntrackedProductionPath(p);
}

/**
 * The live documents a goal owns: the ones whose latest write served it (an
 * edit without a goal keeps the earlier one), not archived or deleted, still
 * on disk. In changelog order.
 */
export function goalDocuments(
  entries: ProductionEntry[],
  goalId: string,
  exists: (relPath: string) => boolean
): string[] {
  const owner = new Map<string, string | undefined>();
  for (const e of entries) {
    if (e.action === 'archive' || e.action === 'delete') {
      owner.delete(e.archivedFrom ?? e.path);
      owner.delete(e.path);
      continue;
    }
    owner.set(e.path, e.goalId ?? owner.get(e.path));
  }
  return [...owner]
    .filter(([path, g]) => g === goalId && isDocumentPath(path) && exists(path))
    .map(([path]) => path);
}

export interface LivingDocCheck {
  /** `file_write` or `file_edit`. */
  tool: string;
  /** Target path relative to the productions dir, `/`-separated. */
  relPath: string;
  args: Record<string, unknown>;
  /** The cycle is a curiosity explore cycle. */
  exploring: boolean;
  /** The goal the cycle serves, when it is known. */
  goalId?: string | null;
  /** The bot's productions changelog. */
  entries: ProductionEntry[];
  exists: (relPath: string) => boolean;
  read: (relPath: string) => string | null;
  maxChars: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const firstOf = (args: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) if (str(args[k])) return str(args[k]);
  return '';
};

/** The document as the write would leave it, or null when it cannot be told (the tool will fail anyway). */
function resultingText(c: LivingDocCheck, current: string | null): string | null {
  if (c.tool === 'file_write') {
    const content = str(c.args.content);
    return c.args.append ? `${current ?? ''}${content}` : content;
  }
  if (c.tool === 'file_edit') {
    if (current === null) return null;
    const oldText = firstOf(c.args, ['old_text', 'old_string', 'oldText', 'search']);
    const newText = firstOf(c.args, ['new_text', 'new_string', 'newText', 'replace']);
    if (!oldText || !current.includes(oldText)) return null;
    return c.args.replace_all ? current.split(oldText).join(newText) : current.replace(oldText, () => newText);
  }
  return null;
}

/** Why this write breaks the living-document rules, as the tool result the agent reads; undefined when it is fine. */
export function livingDocRefusal(c: LivingDocCheck): string | undefined {
  if (c.tool !== 'file_write' && c.tool !== 'file_edit') return undefined;
  const path = c.relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!isDocumentPath(path)) return undefined;

  if (c.exploring) {
    return `Not written: this is an exploration cycle. Save what you found to memory (save_memory or core memory) with its sources; documents in productions are for the goals you work on, and an exploration finding that matters will reach them through a goal.`;
  }

  const exists = c.exists(path);
  if (c.tool === 'file_write' && !exists && !c.args.append && c.goalId) {
    const docs = goalDocuments(c.entries, c.goalId, c.exists);
    if (docs.length > 0) {
      const named = docs.slice(0, 5).join(', ');
      return `Not written: goal ${c.goalId} already has its document (${named}). Update that document instead of starting a new file: file_edit the section that changed, or file_write the whole document to its path. Fold the new finding in and cut what it supersedes. If several are listed, pick the one this belongs to.`;
    }
  }

  const current = exists ? c.read(path) : null;
  const next = resultingText(c, current);
  if (next === null) return undefined;
  const before = current?.length ?? 0;
  if (next.length > c.maxChars && next.length > before) {
    return `Not written: ${path} would be ${next.length} characters; documents stay under ${c.maxChars}. Make it shorter and truer: cut what the new finding supersedes, merge repeated points, keep the conclusion, the key numbers and their sources. Then write it again.`;
  }
  return undefined;
}

export interface DocumentSize {
  path: string;
  chars: number;
  goalId?: string;
}

/** The documents at the productions root, by name, with their size and the goal that last wrote them. Never throws. */
export function listDocuments(dir: string, entries: ProductionEntry[]): DocumentSize[] {
  try {
    if (!existsSync(dir)) return [];
    const owner = new Map<string, string | undefined>();
    for (const e of entries) {
      if (e.action === 'archive' || e.action === 'delete') continue;
      owner.set(e.path, e.goalId ?? owner.get(e.path));
    }
    return readdirSync(dir)
      .filter((f) => isDocumentPath(f))
      .filter((f) => statSync(join(dir, f)).isFile())
      .sort()
      .map((f) => {
        const goalId = owner.get(f);
        return { path: f, chars: statSync(join(dir, f)).size, ...(goalId ? { goalId } : {}) };
      });
  } catch {
    return [];
  }
}

const n = (v: number) => v.toLocaleString('en-US');

/** The executor's view of its documents: the cap, each size against it and the room left. */
export function documentsSection(docs: DocumentSize[], maxChars: number): string {
  const lines = [`Limit: ${n(maxChars)} characters per document.`];
  if (docs.length === 0) {
    lines.push('No documents yet.');
    return lines.join('\n');
  }
  lines.push('Your documents now:');
  for (const d of docs) {
    const goal = d.goalId ? ` (goal ${d.goalId})` : '';
    const left = maxChars - d.chars;
    const room =
      left < 0
        ? ' — over the limit: it can only get shorter'
        : left < maxChars * 0.1
          ? ` — ${n(left)} left, cut before you add`
          : ` — ${n(left)} left`;
    lines.push(`- ${d.path}${goal}: ${n(d.chars)} / ${n(maxChars)}${room}`);
  }
  return lines.join('\n');
}

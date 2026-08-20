/**
 * HTML — bot production directory index generator.
 *
 * Extracts the index.html emitter, formatters, and goals reader from
 * ProductionsService. Per docs/architecture-docs/productions-refactor.md
 * §4 C4.
 *
 * Module boundary:
 *   - Pure functions on the production directory. With one exception:
 *     rebuildIndexPure reads the filesystem (dir walk, changelog, goals
 *     file) and writes the generated index.html. It does NOT call
 *     runCleanup — that is the caller's responsibility (consistent with
 *     the C2 architecture).
 *   - No imports from ProductionsService or other ProductionsService
 *     modules except paths.ts (for INDEX_EXCLUDES) and frontmatter.ts
 *     (for extractDescription + resolveCreatedAt).
 *
 * Consumed by ProductionsService (via thin wrappers) and by tests
 * (tests/productions/html.test.ts).
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseGoals } from '../tools/goals';
import { INDEX_EXCLUDES } from './paths';
import { extractDescription, resolveCreatedAt } from './frontmatter';
import type { ProductionEntry } from './types';

// ---------------------------------------------------------------------------
// Pure formatters
// ---------------------------------------------------------------------------

/** Format a Date as `YYYY-MM-DD HH:mm` (UTC). */
export function formatDatetime(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** Escape HTML-unsafe characters: &, <, >, ". */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Return an emoji for a file based on its extension. */
export function fileIcon(name: string): string {
  if (name.endsWith('.md')) return '\u{1F4DD}';
  if (name.endsWith('.html')) return '\u{1F310}';
  if (name.endsWith('.json')) return '\u{1F4CB}';
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return '\u{1F4CA}';
  if (name.endsWith('.py') || name.endsWith('.ts') || name.endsWith('.js')) return '\u{1F4BB}';
  return '\u{1F4C4}';
}

/** Format a byte count as B / KB / MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Goals reader
// ---------------------------------------------------------------------------

/**
 * Fallback parser for GOALS.md files that don't follow the standard
 * `## Active Goals` + `- [ ] text` format. Extracts items from the
 * first `##` section, handling bold-prefixed bullets.
 */
export function parseFirstSectionAsBullets(
  content: string,
): Array<{ text: string; status: string; priority: string }> {
  const lines = content.split('\n');
  let inFirstSection = false;
  const goals: Array<{ text: string; status: string; priority: string }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      if (inFirstSection) break;
      inFirstSection = true;
      continue;
    }
    if (!inFirstSection) continue;

    const boldMatch = trimmed.match(/^- \*\*(.+?)\*\*(?::\s*(.+))?$/);
    if (boldMatch) {
      const desc = boldMatch[2] ? `${boldMatch[1]}: ${boldMatch[2]}` : boldMatch[1];
      goals.push({ text: desc, status: 'pending', priority: 'medium' });
      continue;
    }
    const plainMatch = trimmed.match(/^- (.+)$/);
    if (plainMatch && !plainMatch[1].startsWith('[')) {
      goals.push({ text: plainMatch[1], status: 'pending', priority: 'medium' });
    }
  }
  return goals;
}

/**
 * Read and parse active goals from a bot's GOALS.md soul file.
 *
 * Returns structured goal data for embedding in the production index.
 * Tolerant: missing file, missing `## Active Goals`, all-empty → `[]`.
 *
 * The `soulDir` parameter is the bot's soul directory (parent of
 * GOALS.md). Caller is responsible for resolving it.
 */
export function readActiveGoals(
  soulDir: string,
): Array<{ text: string; status: string; priority: string; notes?: string }> {
  const goalsPath = join(soulDir, 'GOALS.md');
  try {
    if (!existsSync(goalsPath)) return [];
    const content = readFileSync(goalsPath, 'utf-8');
    const { active } = parseGoals(content);
    if (active.length > 0) {
      return active.map((g) => ({
        text: g.text,
        status: g.status,
        priority: g.priority,
        notes: g.notes,
      }));
    }
    return parseFirstSectionAsBullets(content);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Description lookup
// ---------------------------------------------------------------------------

/**
 * Get description for a file: changelog first, then rich extract from
 * the file content (md/txt), then humanized filename.
 */
export function getFileDescription(
  relPath: string,
  descMap: Map<string, string>,
  absPath: string,
): string {
  const changelogDesc = descMap.get(relPath);
  if (
    changelogDesc &&
    !changelogDesc.startsWith('file_write:') &&
    !changelogDesc.startsWith('file_edit:')
  ) {
    return changelogDesc.slice(0, 120);
  }

  try {
    if (existsSync(absPath) && (absPath.endsWith('.md') || absPath.endsWith('.txt'))) {
      const content = readFileSync(absPath, 'utf-8');
      const desc = extractDescription(content);
      if (desc) return desc;
    }
  } catch {
    /* skip */
  }

  const name = basename(relPath, '.md');
  return name
    .replace(/^\d{2}_/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Pure HTML builder
// ---------------------------------------------------------------------------

export interface FileInfo {
  relativePath: string;
  name: string;
  dir: string;
  size: number;
  created: Date;
  isArchived: boolean;
  description: string;
}

export interface GoalInfo {
  text: string;
  status: string;
  priority: string;
  notes?: string;
}

/**
 * Generate the static index.html string for a bot's production dir.
 *
 * Self-contained HTML document — no script tags, no external resources.
 * The caller is responsible for joining description + files + goals and
 * deciding what to render; this function takes them fully-resolved.
 */
export function buildIndexHtml(
  botId: string,
  files: FileInfo[],
  goals: GoalInfo[],
  dirCount: number,
  totalSize: number,
): string {
  const nonArchived = files.filter((f) => !f.isArchived);
  const archived = files.filter((f) => f.isArchived);

  const groups = new Map<string, FileInfo[]>();
  for (const f of nonArchived) {
    const key = f.dir || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  const sortedGroupKeys = [...groups.keys()].sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return a.localeCompare(b);
  });

  // Build goals HTML
  let goalsHtml = '';
  if (goals.length > 0) {
    goalsHtml = '<h2>Active Goals</h2>\n<div class="goals-list">\n';
    for (const g of goals) {
      const badgeClass =
        g.status === 'in_progress'
          ? 'badge-green'
          : g.status === 'blocked'
            ? 'badge-high'
            : g.status === 'ready_for_human_review' || g.status === 'ready_for_activation'
              ? 'badge-yellow'
              : 'badge-dim';
      const prioClass =
        g.priority === 'high'
          ? 'badge-high'
          : g.priority === 'low'
            ? 'badge-low'
            : 'badge-medium';
      goalsHtml += `<div class="goal-card">
  <div class="goal-text">${escHtml(g.text)}</div>
  <div class="goal-meta"><span class="badge ${badgeClass}">${escHtml(g.status)}</span> <span class="badge ${prioClass}">${escHtml(g.priority)}</span></div>
  ${g.notes ? `<div class="goal-notes">${escHtml(g.notes)}</div>` : ''}
</div>\n`;
    }
    goalsHtml += '</div>\n';
  } else {
    goalsHtml = '<h2>Active Goals</h2>\n<p class="text-dim">No active goals.</p>\n';
  }

  // Build file table HTML (or empty state)
  let tableHtml = '';
  if (nonArchived.length === 0) {
    tableHtml = `<div style="text-align:center;padding:60px 20px">
  <div style="font-size:48px;margin-bottom:16px">\u{1F4C2}</div>
  <h2 style="border:none;margin:0 0 12px;font-size:20px">No productions yet</h2>
  <p class="text-dim" style="max-width:400px;margin:0 auto">This bot hasn't created any production files yet. Once it starts working on its goals, files will appear here.</p>
</div>\n`;
  } else {
    tableHtml = '<h2>Files</h2>\n';
    tableHtml +=
      '<table><thead><tr><th>File</th><th>Description</th><th>Created</th><th>Size</th></tr></thead><tbody>\n';
    const chronoFiles = [...nonArchived].sort((a, b) => b.created.getTime() - a.created.getTime());
    for (const f of chronoFiles) {
      tableHtml += `<tr>
  <td><a href="/#/productions?bot=${escHtml(botId)}&amp;file=${escHtml(f.relativePath)}" class="file-link-inline">${fileIcon(f.name)} ${escHtml(f.name)}</a></td>
  <td class="text-dim">${escHtml(f.description)}</td>
  <td class="text-dim">${formatDatetime(f.created)}</td>
  <td class="text-dim">${formatSize(f.size)}</td>
</tr>\n`;
    }
    tableHtml += '</tbody></table>\n';
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Productions &mdash; ${escHtml(botId)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f1117;--bg-card:#181a20;--bg-hover:#1e2028;--border:#2a2d36;--text:#e0e0e6;--text-dim:#8b8d97;--accent:#6c8cff;--accent-hover:#8da8ff;--green:#34d399;--red:#f87171;--orange:#fbbf24;--purple:#a78bfa;--cyan:#22d3ee;--radius:6px;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,sans-serif;--mono:"SF Mono",SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace}
html{scroll-behavior:smooth}
body{font-family:var(--font);font-size:15px;line-height:1.65;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover);text-decoration:underline}
.content{max-width:960px;margin:0 auto;padding:40px 40px 80px}
.page-header{margin-bottom:36px;padding-bottom:20px;border-bottom:1px solid var(--border)}
.page-header h1{font-size:28px;font-weight:700;margin-bottom:6px}
.page-header p{color:var(--text-dim);font-size:15px}
h2{font-size:22px;font-weight:600;margin:40px 0 16px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.stat-row{display:flex;gap:16px;margin:24px 0;flex-wrap:wrap}
.stat{flex:1;min-width:100px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center}
.stat .number{font-size:28px;font-weight:700;color:var(--accent)}
.stat .label{font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}
thead th{text-align:left;padding:10px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim);border-bottom:2px solid var(--border)}
tbody td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top}
tbody tr:hover{background:var(--bg-hover)}
.text-dim{color:var(--text-dim)}
.badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
.badge-high{background:rgba(248,113,113,.15);color:var(--red)}
.badge-medium{background:rgba(251,191,36,.15);color:var(--orange)}
.badge-low{background:rgba(108,140,255,.15);color:var(--accent)}
.badge-green{background:rgba(52,211,153,.15);color:var(--green)}
.badge-yellow{background:rgba(251,191,36,.15);color:var(--orange)}
.badge-dim{background:rgba(148,163,184,.12);color:var(--text-dim)}
.goal-card{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px}
.goal-text{font-size:14px;margin-bottom:8px}
.goal-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.goal-notes{font-size:12px;color:var(--text-dim);line-height:1.5;margin-top:6px}
@media(max-width:600px){
  .content{padding:40px 16px 60px}
  .stat-row{flex-direction:column}
  table{font-size:13px}
  thead th,tbody td{padding:8px}
}
</style>
</head>
<body>
<div class="content">
  <div class="page-header">
    <h1>Productions &mdash; ${escHtml(botId)}</h1>
    <p>Last updated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
  </div>
  <div class="stat-row">
    <div class="stat"><div class="number">${nonArchived.length}</div><div class="label">Files</div></div>
    <div class="stat"><div class="number">${formatSize(totalSize)}</div><div class="label">Total Size</div></div>
    ${archived.length > 0 ? `<div class="stat"><div class="number">${archived.length}</div><div class="label">Archived</div></div>` : ''}
  </div>
  ${goalsHtml}
  ${tableHtml}
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Pure rebuild (filesystem view, no service dependencies)
// ---------------------------------------------------------------------------

/**
 * Rebuild the auto-generated index.html for a production directory.
 *
 * PURE: reads files, generates HTML, writes the index. Does NOT call
 * runCleanup. The facade (service.ts) is responsible for calling
 * runCleanup when needed and then calling this function.
 *
 * @param botId     The bot id (used for the soul GOALS.md path and the
 *                  page title).
 * @param dir       The resolved production directory.
 * @param soulDir   The resolved soul directory (parent of GOALS.md).
 *
 * Reads the changelog for descriptions and timestamps; walks the
 * directory recursively; reads SOUL GOALS.md for active goals.
 */
export function rebuildIndexPure(botId: string, dir: string, soulDir: string): void {
  const descMap = new Map<string, string>();
  const changelogTimestampMap = new Map<string, string>();
  const changelogPath = join(dir, 'changelog.jsonl');
  if (existsSync(changelogPath)) {
    const rawLines = readFileSync(changelogPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of rawLines) {
      try {
        const entry: ProductionEntry = JSON.parse(line);
        descMap.set(entry.path, entry.description);
        if (entry.action === 'create' && !changelogTimestampMap.has(entry.path)) {
          changelogTimestampMap.set(entry.path, entry.timestamp);
        }
      } catch {
        /* skip */
      }
    }
  }

  const files: FileInfo[] = [];
  let dirCount = 0;

  const walk = (current: string, relPrefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (INDEX_EXCLUDES.has(entry)) continue;
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        dirCount++;
        walk(fullPath, relPrefix ? `${relPrefix}/${entry}` : entry);
      } else {
        const relPath = relPrefix ? `${relPrefix}/${entry}` : entry;
        const created = resolveCreatedAt(
          fullPath,
          relPath,
          stat.birthtime,
          changelogTimestampMap,
        );
        files.push({
          relativePath: relPath,
          name: entry,
          dir: relPrefix,
          size: stat.size,
          created,
          isArchived: relPrefix === 'archived' || relPrefix.startsWith('archived/'),
          description: getFileDescription(relPath, descMap, fullPath),
        });
      }
    }
  };
  walk(dir, '');

  const goals = readActiveGoals(soulDir);
  const totalSize = files.reduce((s, f) => s + f.size, 0);

  const html = buildIndexHtml(botId, files, goals, dirCount, totalSize);

  writeFileSync(join(dir, 'index.html'), html, 'utf-8');
}

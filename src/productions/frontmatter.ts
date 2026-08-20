/**
 * Frontmatter — pure frontmatter / quality helpers.
 *
 * Extracts six pure functions from ProductionsService. Per
 * docs/architecture-docs/productions-refactor.md §4 C2.
 *
 * Module boundary:
 *   - Pure functions (no I/O, no mutation, no dependency on Config or
 *     ProductionsService). Read-only file access via readFileSync is OK
 *     for resolveCreatedAt's priority-1 step; that function is the
 *     exception and is documented as such.
 *   - No imports from other ProductionsService modules.
 *
 * Consumed by ProductionsService (via thin wrappers) and by tests
 * (tests/productions/frontmatter.test.ts).
 */

import { existsSync, readFileSync } from 'node:fs';

/**
 * Assess whether `content` is mostly real content or mostly placeholder.
 *
 * Returns a ratio in [0, 1] of real-content lines to total non-blank
 * lines, and `isTemplate` (true when ratio < 0.3).
 *
 * Placeholder patterns detected:
 *   - Heading with no content (just a heading marker).
 *   - Empty bullet.
 *   - TBD / TODO / FIXME / PLACEHOLDER / $$ / ___ / ... / N/A markers.
 *   - Unchecked checkbox.
 *   - Heading with generic text only (Section, Title, Heading, etc.).
 *   - Separator lines (---, ===, ***, ___).
 */
export function assessContentQuality(content: string): { ratio: number; isTemplate: boolean } {
  if (!content || content.trim().length === 0) {
    return { ratio: 0, isTemplate: true };
  }

  const lines = content.split('\n');
  let totalLines = 0;
  let emptyOrPlaceholderLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue; // skip blank lines entirely

    totalLines++;

    const isPlaceholder =
      /^#{1,6}\s*$/.test(trimmed) ||
      /^[-*]\s*$/.test(trimmed) ||
      /\b(TBD|TODO|FIXME|PLACEHOLDER|\$_{2,}|___+|\.\.\.|N\/A)\b/i.test(trimmed) ||
      /^[-*]\s*\[\s*\]\s*$/.test(trimmed) ||
      /^#{1,6}\s+(Section|Title|Heading|Overview|Introduction|Summary|Conclusion|Details|Notes)\s*$/i.test(
        trimmed,
      ) ||
      /^[-=_*]{3,}$/.test(trimmed);

    if (isPlaceholder) {
      emptyOrPlaceholderLines++;
    }
  }

  if (totalLines === 0) {
    return { ratio: 0, isTemplate: true };
  }

  const ratio = (totalLines - emptyOrPlaceholderLines) / totalLines;
  return { ratio: Math.round(ratio * 100) / 100, isTemplate: ratio < 0.3 };
}

/**
 * Inject YAML frontmatter with `created_at` into markdown content.
 *
 * Only for `.md` files. Skips if content already starts with `---`.
 * If `timestamp` is omitted, the current time is used.
 */
export function injectFrontmatter(content: string, filePath: string, timestamp?: string): string {
  if (!filePath.endsWith('.md')) return content;
  if (content.trimStart().startsWith('---')) return content;
  const ts = timestamp ?? new Date().toISOString();
  return `---\ncreated_at: "${ts}"\n---\n\n${content}`;
}

/**
 * Parse `created_at` from YAML frontmatter. Simple regex-based parser.
 *
 * Returns the ISO string value or null if no frontmatter / no
 * `created_at` / invalid format.
 */
export function parseFrontmatter(content: string): string | null {
  if (!content.trimStart().startsWith('---')) return null;
  const firstDelim = content.indexOf('---');
  const endIdx = content.indexOf('---', firstDelim + 3);
  if (endIdx === -1) return null;
  const frontmatter = content.slice(firstDelim + 3, endIdx);
  const match = frontmatter.match(/created_at:\s*"?([^"\n]+)"?/);
  return match ? match[1].trim() : null;
}

/**
 * Resolve the best `created_at` timestamp for a file.
 *
 * Priority: (1) YAML frontmatter of the file, (2) changelog timestamp
 * for the relative path, (3) stat.birthtime as last resort.
 *
 * Reads the file only when the path is `.md` and the file exists —
 * non-`.md` files go straight to priority 2. This is the one function
 * in the module that touches the filesystem; everything else is pure.
 */
export function resolveCreatedAt(
  absPath: string,
  relPath: string,
  birthtime: Date,
  changelogTimestampMap: Map<string, string>,
): Date {
  // 1) Try YAML frontmatter
  try {
    if (existsSync(absPath) && absPath.endsWith('.md')) {
      const content = readFileSync(absPath, 'utf-8');
      const ts = parseFrontmatter(content);
      if (ts) {
        const d = new Date(ts);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
  } catch {
    /* skip */
  }

  // 2) Try changelog timestamp
  const changelogTs = changelogTimestampMap.get(relPath);
  if (changelogTs) {
    const d = new Date(changelogTs);
    if (!Number.isNaN(d.getTime()) && d.getTime() > 0) return d;
  }

  // 3) Fallback to stat.birthtime
  return birthtime;
}

/**
 * Extract a one-or-two-line description from content.
 *
 * Format: "Title -- First sentence" (or just "Title" / "First sentence"
 * if only one is found). Capped at 120 chars; longer outputs are
 * truncated with "...".
 *
 * Skips bullets, tables, separators, blockquotes, metadata lines
 * (`date: ...`, `author: ...`, etc.). Stops at a second heading or
 * the start of a code block.
 */
export function extractDescription(content: string): string {
  if (!content || content.trim().length === 0) return '';

  const lines = content.split('\n');
  let title = '';
  let firstSentence = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Find first heading
    if (!title) {
      const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) {
        title = headingMatch[1].trim();
        continue;
      }
    }

    // Skip metadata lines, bullets, sub-headings, tables, separators
    if (title && !firstSentence) {
      if (/^#{1,6}\s/.test(trimmed)) break; // hit another heading, stop
      if (/^[-*+]\s/.test(trimmed)) continue; // bullet
      if (/^\|/.test(trimmed)) continue; // table
      if (/^[-=_*]{3,}$/.test(trimmed)) continue; // separator
      if (/^>\s/.test(trimmed)) continue; // blockquote
      if (/^```/.test(trimmed)) break; // code block, stop
      if (/^(date|author|tags|category|status):/i.test(trimmed)) continue; // metadata

      // Found a paragraph line — extract first sentence
      const sentenceMatch = trimmed.match(/^(.+?[.!?])\s/);
      firstSentence = sentenceMatch ? sentenceMatch[1] : trimmed;
      break;
    }
  }

  if (!title && !firstSentence) return '';
  if (!firstSentence) return title.slice(0, 120);
  if (!title) return firstSentence.slice(0, 120);

  const combined = `${title} -- ${firstSentence}`;
  return combined.length > 120 ? `${combined.slice(0, 117)}...` : combined;
}

/**
 * Check coherence of a content string (heuristic, no LLM).
 *
 * Returns whether the content is coherent and a list of human-readable
 * issues found. Three checks:
 *   1. Content too small (< 100 chars of real content).
 *   2. High placeholder ratio (template content).
 *   3. Broken structure (4+ headings with fewer paragraphs).
 *
 * `coherent` is true iff `issues.length === 0`.
 */
export function checkCoherence(content: string): { coherent: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check 1: Too small
  const stripped = content.replace(/\s+/g, '');
  if (stripped.length < 100) {
    issues.push('Content too small (less than 100 characters of real content)');
  }

  // Check 2: Template/placeholder ratio
  const quality = assessContentQuality(content);
  if (quality.isTemplate) {
    issues.push(
      `High placeholder ratio (${Math.round((1 - quality.ratio) * 100)}% placeholder content)`,
    );
  }

  // Check 3: Broken structure
  const lines = content.split('\n');
  let headingCount = 0;
  let paragraphCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) {
      headingCount++;
    } else if (trimmed.length > 20 && !/^[-=_*]{3,}$/.test(trimmed)) {
      paragraphCount++;
    }
  }
  if (headingCount >= 4 && paragraphCount < headingCount) {
    issues.push(
      `Broken structure: ${headingCount} headings but only ${paragraphCount} content paragraphs`,
    );
  }

  return { coherent: issues.length === 0, issues };
}

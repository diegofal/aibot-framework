import type { Page } from 'playwright';

/** Roles that get interactive [ref=eN] tags in the snapshot */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'combobox',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'option',
]);

export interface ElementRef {
  role: string;
  name: string;
}

export interface SnapshotResult {
  text: string;
  refs: Map<string, ElementRef>;
  url: string;
  title: string;
  truncated: boolean;
}

/**
 * Pattern to parse an ariaSnapshot line:
 *   indent "- " role optionalQuotedName rest
 *
 * Examples:
 *   - link "Home"
 *   - heading "Title" [level=1]
 *   - navigation "Main":
 *   - textbox "Email" [checked]
 */
const LINE_RE = /^(\s*-\s+)(\w+)(?:\s+"([^"]*)")?(.*)$/;

/**
 * Process raw ariaSnapshot text: add [ref=eN] tags to interactive elements.
 * Exported for unit testing.
 */
export function addRefsToSnapshot(
  raw: string,
  maxChars: number,
): { text: string; refs: Map<string, ElementRef> } {
  const refs = new Map<string, ElementRef>();
  let refCounter = 0;
  let charCount = 0;
  const lines: string[] = [];

  for (const line of raw.split('\n')) {
    const match = line.match(LINE_RE);

    if (!match) {
      // Non-parseable line (empty, comment, etc.) — pass through
      charCount += line.length + 1;
      if (charCount > maxChars) {
        lines.push('... [snapshot truncated]');
        break;
      }
      lines.push(line);
      continue;
    }

    const [, prefix, role, name, rest] = match;

    if (INTERACTIVE_ROLES.has(role)) {
      refCounter++;
      const refId = `e${refCounter}`;
      refs.set(refId, { role, name: name ?? '' });

      // Build the annotated line: insert [ref=eN] before trailing ':' if present
      const hasColon = rest.trimEnd().endsWith(':');
      const cleanRest = hasColon ? rest.trimEnd().slice(0, -1) : rest;
      const namePart = name != null ? ` "${name}"` : '';
      const newLine = `${prefix}${role}${namePart}${cleanRest} [ref=${refId}]${hasColon ? ':' : ''}`;

      charCount += newLine.length + 1;
      if (charCount > maxChars) {
        lines.push('... [snapshot truncated]');
        break;
      }
      lines.push(newLine);
    } else {
      charCount += line.length + 1;
      if (charCount > maxChars) {
        lines.push('... [snapshot truncated]');
        break;
      }
      lines.push(line);
    }
  }

  return { text: lines.join('\n'), refs };
}

/**
 * Take an accessibility snapshot of the current page and format it.
 * Uses Playwright's ariaSnapshot() which returns an indented text
 * representation of the accessibility tree.
 */
export async function takeSnapshot(
  page: Page,
  maxChars: number,
): Promise<SnapshotResult> {
  const url = page.url();
  const title = await page.title();

  let raw: string;
  try {
    raw = await page.locator('body').ariaSnapshot();
  } catch {
    return {
      text: '(empty page — no accessibility tree)',
      refs: new Map(),
      url,
      title,
      truncated: false,
    };
  }

  if (!raw || raw.trim() === '') {
    return {
      text: '(empty page — no accessibility tree)',
      refs: new Map(),
      url,
      title,
      truncated: false,
    };
  }

  const { text: body, refs } = addRefsToSnapshot(raw, maxChars);
  const header = `Page: ${title} | ${url}\n---`;
  const fullText = `${header}\n${body}`;
  const truncated = fullText.length >= maxChars;

  return { text: fullText, refs, url, title, truncated };
}

/**
 * DOM-free helpers for settings.js. Kept separate because settings.js imports
 * shared.js, which touches `document` at module scope — importable only in a
 * browser. Pure functions that need testing live here instead (same split as
 * stats.js / stats-helpers.js).
 */

/** Minimal HTML-attribute/text escape — no DOM dependency (contrast shared.js's div-based one). */
export function escapeHtmlPure(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Model dropdown for the Claude CLI backend, sourced from the server's
 * `availableModels` (the same alias list `--model` actually accepts — see
 * src/claude-cli.ts CLAUDE_CLI_MODEL_OPTIONS). If the saved value isn't one of
 * the known aliases (a full/dated model id someone typed in before this was a
 * dropdown), it's kept as a selected custom option so saving never silently
 * discards it.
 */
export function ccliModelSelect(claudeCli) {
  const options = claudeCli.availableModels || [{ value: '', label: 'CLI default' }];
  const current = claudeCli.model || '';
  const known = options.some((o) => o.value === current);
  const extra =
    !known && current
      ? `<option value="${escapeHtmlPure(current)}" selected>${escapeHtmlPure(current)} (custom)</option>`
      : '';
  const optionsHtml = options
    .map(
      (o) =>
        `<option value="${escapeHtmlPure(o.value)}"${o.value === current ? ' selected' : ''}>${escapeHtmlPure(o.label)}</option>`
    )
    .join('');
  return `<select id="ccli-model">${optionsHtml}${extra}</select>`;
}

// ── Sticky save bar (UX overhaul phase 5) ──────────────────────────────

/**
 * Sections saved by the one sticky save bar, in page order. `anchor` is the
 * element id of the section's card. MCP servers and System backup keep their
 * own immediate actions and are only jump-link targets (JUMP_SECTIONS).
 */
export const SAVE_SECTIONS = [
  { id: 'skillFolders', label: 'Skill folders', anchor: 'settings-skill-folders', restart: true },
  { id: 'claudeCli', label: 'Claude CLI', anchor: 'settings-claude-cli' },
  { id: 'healthCheck', label: 'Health check', anchor: 'settings-health-check' },
  { id: 'session', label: 'Group activation & sessions', anchor: 'settings-session' },
  { id: 'collaboration', label: 'Collaboration', anchor: 'settings-collaboration' },
  { id: 'memorySearch', label: 'Memory search', anchor: 'settings-memory-search' },
];

export const JUMP_SECTIONS = [
  { label: 'Skill folders', anchor: 'settings-skill-folders' },
  { label: 'MCP servers', anchor: 'settings-mcp' },
  { label: 'Claude CLI', anchor: 'settings-claude-cli' },
  { label: 'Health check', anchor: 'settings-health-check' },
  { label: 'Group activation', anchor: 'settings-session' },
  { label: 'Collaboration', anchor: 'settings-collaboration' },
  { label: 'Memory search', anchor: 'settings-memory-search' },
  { label: 'Backup', anchor: 'settings-backup' },
];

const labelOf = (id) => SAVE_SECTIONS.find((s) => s.id === id)?.label ?? id;

/** JSON with object keys sorted, so equal values compare equal as strings. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Ids of the sections whose current value differs from the baseline. */
export function dirtySections(baseline, current) {
  return SAVE_SECTIONS.map((s) => s.id).filter(
    (id) => stableStringify(baseline?.[id]) !== stableStringify(current?.[id])
  );
}

/** Sticky bar listing the dirty sections; '' when nothing is dirty. */
export function saveBarMarkup(dirty, { errors = {}, saving = false } = {}) {
  const ids = dirty ?? [];
  if (ids.length === 0) return '';
  const dis = saving ? ' disabled' : '';
  const errs = ids
    .filter((id) => errors[id])
    .map(
      (id) =>
        `<div class="settings-savebar-error">${escapeHtmlPure(labelOf(id))}: ${escapeHtmlPure(errors[id])}</div>`
    )
    .join('');
  return `<div class="settings-savebar" role="region" aria-label="Unsaved changes">
    <div class="settings-savebar-text"><strong>Unsaved changes</strong> in ${ids.length} section${
      ids.length === 1 ? '' : 's'
    }: ${ids.map((id) => escapeHtmlPure(labelOf(id))).join(', ')}${errs}</div>
    <div class="settings-savebar-actions">
      <button type="button" class="btn btn-sm" data-savebar="discard"${dis}>Discard</button>
      <button type="button" class="btn btn-sm btn-primary" data-savebar="save"${dis}>${
        saving ? 'Saving…' : 'Save changes'
      }</button>
    </div>
  </div>`;
}

/** `results = [{ id, error? }]` → `{ tone, text }` for the toast. */
export function saveSummary(results) {
  const list = results ?? [];
  const failed = list.filter((r) => r.error);
  if (failed.length === 0) {
    const restart = list.some((r) => SAVE_SECTIONS.find((s) => s.id === r.id)?.restart);
    return {
      tone: 'ok',
      text: `Saved ${list.map((r) => labelOf(r.id)).join(', ')}${
        restart ? ' (skill folders apply on restart)' : ''
      }`,
    };
  }
  return {
    tone: 'danger',
    text: `Saved ${list.length - failed.length} of ${list.length} — failed: ${failed
      .map((r) => labelOf(r.id))
      .join(', ')}`,
  };
}

/**
 * Section jump links. Buttons, not `href="#..."` anchors: the dashboard
 * routes on the hash, so an in-page anchor would navigate away.
 */
export function jumpLinksMarkup(sections = JUMP_SECTIONS) {
  return `<nav class="settings-jump" aria-label="Settings sections">${sections
    .map(
      (s) =>
        `<button type="button" class="settings-jump-link" data-jump="${escapeHtmlPure(s.anchor)}">${escapeHtmlPure(
          s.label
        )}</button>`
    )
    .join('')}</nav>`;
}

/** Keys Settings binds, for the `?` help sheet (registerPageShortcuts). */
export const SETTINGS_SHORTCUTS = [['Ctrl/⌘ + S', 'Save the changed sections']];

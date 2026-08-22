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

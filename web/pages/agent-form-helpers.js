/**
 * DOM-free helpers for the agent edit form (importable from tests/web/).
 *
 * The form's first "Model" select conflates backend and model: Ollama model
 * names are offered next to the literal `claude-cli`. When `claude-cli` is
 * chosen, a second select lets the operator pin which Claude model this
 * agent uses; empty means the fleet-wide default from Settings → Claude CLI.
 */

function esc(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The agent's pinned Claude model, or '' when it follows the global default. */
export function agentClaudeModel(agent) {
  return agent?.llmBackend === 'claude-cli' && agent?.model ? String(agent.model) : '';
}

/**
 * `<select name="claudeModel">` for the edit form. `defaults.claudeCliModels`
 * is the server's CLAUDE_CLI_MODEL_OPTIONS (its empty entry is skipped here
 * because "Global default" takes that slot); `defaults.claudeCliModel` is the
 * fleet-wide value. A pinned value that is not in the list stays selectable
 * as "(custom)" so saving never drops it.
 */
export function claudeModelSelect(defaults = {}, agent = {}) {
  const current = agentClaudeModel(agent);
  const options = (defaults.claudeCliModels || []).filter((o) => o?.value);
  const globalLabel = defaults.claudeCliModel ? defaults.claudeCliModel : 'CLI default';
  const known = options.some((o) => o.value === current);
  const rows = options
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${o.value === current ? ' selected' : ''}>${esc(o.label)}</option>`
    )
    .join('');
  const custom =
    current && !known
      ? `<option value="${esc(current)}" selected>${esc(current)} (custom)</option>`
      : '';
  return `<select name="claudeModel" id="agent-claude-model"><option value=""${
    current ? '' : ' selected'
  }>Global default (${esc(globalLabel)})</option>${rows}${custom}</select>`;
}

/** Text shown on the Config page's "Model" row. */
export function effectiveModelLabel(agent = {}, defaults = {}) {
  if (agent.llmBackend === 'claude-cli') {
    const pinned = agentClaudeModel(agent);
    if (pinned) return { text: `claude-cli · ${pinned}`, global: false };
    return {
      text: `claude-cli · ${defaults.claudeCliModel || 'CLI default'}`,
      global: true,
    };
  }
  if (agent.model) return { text: String(agent.model), global: false };
  return { text: String(defaults.model ?? ''), global: true };
}

/** Whether the Claude model select should be visible for the current backend choice. */
export function showClaudeModelSelect(modelSelectValue) {
  return modelSelectValue === 'claude-cli';
}

// ── Edit form ergonomics (UX overhaul phase 5) ───────────────────────────────

/**
 * Where Save / Cancel on the edit form go: back to the page the user came
 * from when that is this agent's Home or Config (or the list), else Home.
 */
export function editReturnHash(id, prevHash) {
  const enc = encodeURIComponent(String(id ?? ''));
  const home = `#/agents/${enc}`;
  const prev = String(prevHash ?? '');
  if (prev === '#/agents') return prev;
  const m = prev.match(/^#\/agents\/([^/?]+)(\/config)?$/);
  if (!m) return home;
  let seg = m[1];
  try {
    seg = decodeURIComponent(seg);
  } catch {
    /* keep raw */
  }
  if (seg !== String(id)) return home;
  return m[2] ? `${home}/config` : home;
}

/**
 * Stable fingerprint of a form's values for dirty tracking. `fields` are
 * form controls (or plain `{ name, type, value, checked }` objects).
 */
export function snapshotForm(fields) {
  const parts = [];
  for (const f of fields ?? []) {
    if (!f?.name) continue;
    const t = String(f.type ?? '');
    const v = t === 'checkbox' || t === 'radio' ? `${f.value}:${Boolean(f.checked)}` : f.value;
    parts.push(`${f.name}=${v ?? ''}`);
  }
  return parts.join('\u0001');
}

/** Ctrl+S / Cmd+S (no Alt). */
export function isSaveShortcut(e) {
  return Boolean(
    e && (e.ctrlKey || e.metaKey) && !e.altKey && String(e.key ?? '').toLowerCase() === 's'
  );
}

/**
 * Sticky section jump list for the edit form. Buttons, not `#` links: a hash
 * href would hit the router.
 */
export function editSectionNav(sections = []) {
  return `<nav class="edit-jump" aria-label="Form sections">${sections
    .map(
      (s) =>
        `<button type="button" class="edit-jump-link" data-jump="${esc(s.id)}">${esc(s.label)}</button>`
    )
    .join('')}</nav>`;
}

/**
 * Config page token cell. The server only ever sends a masked preview
 * (`1234****abcd`) or a `${ENV}` reference; it stays hidden until Show.
 */
export function tokenCell(token) {
  const t = String(token ?? '');
  if (!t) return '<span class="text-dim">None (headless: web chat only)</span>';
  return `<span class="agent-token"><code class="agent-token-value" data-token-value="${esc(
    t
  )}">••••••••</code><button type="button" class="btn btn-sm" data-token-toggle aria-pressed="false">Show</button><button type="button" class="btn btn-sm" data-token-copy title="Copy what the server shows (a masked preview or the env reference)">Copy</button></span>`;
}

/** Keys the agent edit form binds, for the `?` help sheet (registerPageShortcuts). */
export const AGENT_EDIT_SHORTCUTS = [['Ctrl/⌘ + S', 'Save']];

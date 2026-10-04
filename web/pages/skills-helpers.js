/**
 * Skills list + create-flow helpers (UX overhaul phase 3/5).
 *
 * Pure functions, no DOM: `tests/web/skills-helpers.test.ts` covers them.
 * `skills.js` keeps fetching and event wiring.
 */
import { esc } from '../ui/index.js';

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** Built-in skills carry `enabled`; external skills are always live. */
function isEnabled(skill) {
  return skill?.type === 'builtin' ? skill.enabled !== false : true;
}

export function filterSkills(skills, { query = '', type = '', status = '' } = {}) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  return (Array.isArray(skills) ? skills : []).filter((s) => {
    if (type && s.type !== type) return false;
    if (status === 'enabled' && !isEnabled(s)) return false;
    if (status === 'disabled' && isEnabled(s)) return false;
    if (q) {
      const hay = [s.id, s.name, s.description, s.botName].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function option(value, label, current) {
  return `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
}

export function skillsToolbar({ query = '', type = '', status = '' } = {}) {
  return `<div class="skills-toolbar">
    <input type="search" id="skills-filter-query" class="skills-filter-query" data-page-filter placeholder="Filter skills…" aria-label="Filter skills" value="${esc(
      query
    )}">
    <select id="skills-filter-type" aria-label="Filter by type">
      ${option('', 'All types', type)}${option('builtin', 'Built-in', type)}${option(
        'external',
        'External',
        type
      )}
    </select>
    <select id="skills-filter-status" aria-label="Filter by status">
      ${option('', 'Any status', status)}${option('enabled', 'Enabled', status)}${option(
        'disabled',
        'Disabled',
        status
      )}
    </select>
  </div>`;
}

/**
 * Field -> message for the create form. `mode: 'ai'` needs every field (the
 * generator works from the purpose); `'manual'` only id + name.
 */
export function validateSkillCreate(fields, mode = 'ai') {
  const f = fields ?? {};
  const v = (k) => String(f[k] ?? '').trim();
  const errors = {};
  if (!v('id')) errors.id = 'ID is required.';
  else if (!SLUG.test(v('id')))
    errors.id = 'Use a slug: lowercase letters, digits, "-" or "_" (e.g. my-skill).';
  if (!v('name')) errors.name = 'Name is required.';
  if (mode === 'ai') {
    if (!v('description')) errors.description = 'Description is required for AI generation.';
    if (!v('purpose')) errors.purpose = 'Describe the purpose so the AI knows what to build.';
  }
  return errors;
}

import { describe, expect, it } from 'bun:test';
import {
  applyToggleResult,
  deleteTargets,
  filterSkills,
  skillsBulkBar,
  skillsToolbar,
  toggleSummary,
  toggleTargets,
  validateSkillCreate,
} from '../../web/pages/skills-helpers.js';

describe('skills bulk toggle helpers', () => {
  const list = [
    { id: 'a', type: 'builtin', enabled: true },
    { id: 'b', type: 'builtin', enabled: false },
    { id: 'c', type: 'builtin', enabled: false },
    { id: 'x', type: 'external' },
  ];

  it('toggleTargets keeps only selected built-ins that would actually change', () => {
    const sel = new Set(['a', 'b', 'c', 'x', 'gone']);
    expect(toggleTargets(list, sel, true)).toEqual(['b', 'c']);
    expect(toggleTargets(list, sel, false)).toEqual(['a']);
  });

  it('skillsBulkBar: shared toolbar with Enable / Disable / Delete counts', () => {
    const html = skillsBulkBar({
      visibleIds: ['a', 'b', 'c', 'x'],
      selected: new Set(['a', 'b', 'x']),
      enable: 2,
      disable: 0,
      remove: 1,
    });
    expect(html).toContain('3 of 4 selected');
    expect(html).toContain('Enable 2');
    expect(html).not.toContain('data-bulk="disable"');
    expect(html).toContain('Delete 1');
    expect(html).toContain('data-bulk="clear"');
    expect(skillsBulkBar({ visibleIds: ['a'] })).toContain('Select all');
    expect(skillsBulkBar({ visibleIds: [] })).toBe('');
  });

  it('deleteTargets picks only selected external skills', () => {
    expect(deleteTargets(list, new Set(['a', 'x', 'nope']))).toEqual(['x']);
  });

  it('applyToggleResult sets built-in `enabled` from the server list and leaves externals alone', () => {
    const next = applyToggleResult(list, { enabled: ['b'] });
    expect(next.map((s) => s.enabled)).toEqual([false, true, false, undefined]);
    expect(list[1].enabled).toBe(false);
  });

  it('toggleSummary counts successes, names failures and flags the restart', () => {
    const res = {
      results: [
        { id: 'b', ok: true },
        { id: 'c', ok: true },
        { id: 'zz', ok: false, error: 'Unknown built-in skill' },
      ],
      restartRequired: true,
    };
    expect(toggleSummary(res, true)).toEqual({
      text: 'Enabled 2 skills · 1 failed (zz: Unknown built-in skill). Takes effect after a restart.',
      tone: 'warn',
    });
    expect(
      toggleSummary({ results: [{ id: 'a', ok: true }], restartRequired: true }, false)
    ).toEqual({ text: 'Disabled 1 skill. Takes effect after a restart.', tone: 'ok' });
    expect(
      toggleSummary({ results: [{ id: 'a', ok: true }], restartRequired: false }, true).text
    ).toBe('Enabled 1 skill.');
  });
});

const skills = [
  { id: 'reflection', name: 'Reflection', type: 'builtin', enabled: true, description: 'nightly' },
  { id: 'weather', name: 'Weather', type: 'builtin', enabled: false },
  { id: 'gh', name: 'GitHub', type: 'external', description: 'repos', botName: 'Cryptik' },
];

describe('filterSkills', () => {
  it('returns everything with no filter', () => {
    expect(filterSkills(skills, {})).toHaveLength(3);
  });
  it('matches name, id, description and bot name case-insensitively', () => {
    expect(filterSkills(skills, { query: 'NIGHT' }).map((s) => s.id)).toEqual(['reflection']);
    expect(filterSkills(skills, { query: 'cryptik' }).map((s) => s.id)).toEqual(['gh']);
  });
  it('filters by type', () => {
    expect(filterSkills(skills, { type: 'external' }).map((s) => s.id)).toEqual(['gh']);
    expect(filterSkills(skills, { type: 'builtin' })).toHaveLength(2);
  });
  it('filters by status; external skills count as enabled', () => {
    expect(filterSkills(skills, { status: 'disabled' }).map((s) => s.id)).toEqual(['weather']);
    expect(filterSkills(skills, { status: 'enabled' }).map((s) => s.id)).toEqual([
      'reflection',
      'gh',
    ]);
  });
  it('tolerates a non-array', () => {
    expect(filterSkills(null, {})).toEqual([]);
  });
});

describe('skillsToolbar', () => {
  it('marks the search box as the page filter and keeps the selection', () => {
    const html = skillsToolbar({ query: 'a"b', type: 'external', status: 'disabled' });
    expect(html).toContain('data-page-filter');
    expect(html).toContain('value="a&quot;b"');
    expect(html).toContain('<option value="external" selected>');
    expect(html).toContain('<option value="disabled" selected>');
  });
});

describe('validateSkillCreate', () => {
  const full = { id: 'my-skill', name: 'My', description: 'd', purpose: 'p' };
  it('accepts a complete AI request', () => {
    expect(validateSkillCreate(full, 'ai')).toEqual({});
  });
  it('requires every field for AI generation', () => {
    const errs = validateSkillCreate({ id: 'x' }, 'ai');
    expect(Object.keys(errs).sort()).toEqual(['description', 'name', 'purpose']);
  });
  it('only requires id and name for a manual skill', () => {
    expect(validateSkillCreate({ id: 'x', name: 'X' }, 'manual')).toEqual({});
    expect(Object.keys(validateSkillCreate({ name: '  ' }, 'manual')).sort()).toEqual([
      'id',
      'name',
    ]);
  });
  it('rejects an id that is not a slug', () => {
    expect(validateSkillCreate({ ...full, id: 'My Skill' }, 'ai').id).toMatch(/slug/i);
  });
});

import { describe, expect, it } from 'bun:test';
import {
  filterSkills,
  skillsToolbar,
  validateSkillCreate,
} from '../../web/pages/skills-helpers.js';

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

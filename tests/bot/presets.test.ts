/**
 * Agent presets (session S7 of docs/plans/jarvis-fleet-plan.md): five starting
 * points the wizard and `POST /api/agents` can apply. Pure data + pure merge;
 * no LLM, no disk.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { personalityToTraits } from '../../src/bot/agent-wizard';
import {
  type AgentPreset,
  AgentPresetSchema,
  PRESET_IDS,
  applyPreset,
  getPreset,
  listPresets,
  presetGoalsMarkdown,
  presetSummary,
  presetToBotConfig,
  presetToTemplateConfig,
} from '../../src/bot/presets';
import { TOOL_CATEGORIES } from '../../src/bot/tool-registry';
import { BotConfigSchema } from '../../src/config';
import { parseGoals } from '../../src/tools/goals';

const KNOWN_TOOLS = new Set(Object.values(TOOL_CATEGORIES).flat());
const SKILLS_DIR = join(import.meta.dir, '..', '..', 'src', 'skills');

describe('preset catalogue', () => {
  it('ships exactly the five presets the plan names, in that order', () => {
    expect(PRESET_IDS).toEqual(['assistant', 'researcher', 'job-seeker', 'coder', 'social']);
    expect(listPresets().map((p) => p.id)).toEqual([...PRESET_IDS]);
  });

  it('getPreset finds by id and returns undefined otherwise', () => {
    expect(getPreset('researcher')?.name).toBeTruthy();
    expect(getPreset('nope')).toBeUndefined();
    expect(getPreset('')).toBeUndefined();
    expect(getPreset(undefined)).toBeUndefined();
  });

  it('listPresets hands out copies — mutating one does not change the catalogue', () => {
    const a = listPresets()[0];
    a.skills.push('mutated');
    a.personality.warmth = -1;
    expect(getPreset(a.id)?.skills).not.toContain('mutated');
    expect(getPreset(a.id)?.personality.warmth).toBeGreaterThanOrEqual(0);
  });

  for (const preset of listPresets()) {
    describe(`preset ${preset.id}`, () => {
      it('validates against AgentPresetSchema and has every field the wizard prefills', () => {
        expect(() => AgentPresetSchema.parse(preset)).not.toThrow();
        expect(preset.name.length).toBeGreaterThan(1);
        expect(preset.emoji.length).toBeGreaterThan(0);
        expect(preset.description.length).toBeGreaterThan(10);
        expect(preset.description.includes('\n')).toBe(false);
        expect(preset.purpose.length).toBeGreaterThanOrEqual(8);
        expect(preset.quirks.length).toBeGreaterThan(0);
        for (const axis of ['warmth', 'boldness', 'rigor', 'playfulness'] as const) {
          expect(preset.personality[axis]).toBeGreaterThanOrEqual(0);
          expect(preset.personality[axis]).toBeLessThanOrEqual(1);
        }
        expect(preset.goals.length).toBeGreaterThan(0);
        expect(['periodic', 'continuous']).toContain(preset.agentLoop.mode);
        expect(preset.agentLoop.every).toMatch(/^\d+[mhd]$/);
      });

      it('only names skills that exist under src/skills and tools the registry knows', () => {
        for (const skill of preset.skills) {
          expect([skill, existsSync(join(SKILLS_DIR, skill, 'skill.json'))]).toEqual([skill, true]);
        }
        for (const tool of preset.disabledTools) {
          expect([tool, KNOWN_TOOLS.has(tool)]).toEqual([tool, true]);
        }
        expect(new Set(preset.skills).size).toBe(preset.skills.length);
        expect(new Set(preset.disabledTools).size).toBe(preset.disabledTools.length);
      });

      it('builds a bot that BotConfigSchema accepts', () => {
        const bot = presetToBotConfig(preset, `${preset.id}-bot`);
        const parsed = BotConfigSchema.parse(bot);
        expect(parsed.id).toBe(`${preset.id}-bot`);
        expect(parsed.name).toBe(preset.name);
        expect(parsed.token).toBe('');
        expect(parsed.skills).toEqual(preset.skills);
        expect(parsed.disabledTools).toEqual(preset.disabledTools);
        expect(parsed.agentLoop?.every).toBe(preset.agentLoop.every);
        expect(parsed.agentLoop?.mode).toBe(preset.agentLoop.mode);
      });

      it('writes GOALS.md the goals parser reads back, purpose goal first', () => {
        const md = presetGoalsMarkdown(preset, 'Custom purpose sentence.');
        const { active, completed } = parseGoals(md);
        expect(completed).toEqual([]);
        expect(active.length).toBe(preset.goals.length + 1);
        expect(active[0].text).toContain('Custom purpose sentence.');
        expect(active[0].source).toBe('wizard');
        for (const [i, goal] of preset.goals.entries()) {
          expect(active[i + 1].text).toBe(goal.text);
          expect(active[i + 1].priority).toBe(goal.priority);
          expect(active[i + 1].source).toBe(`preset:${preset.id}`);
          if (goal.notes) expect(active[i + 1].notes).toBe(goal.notes);
        }
      });

      it('maps to trait registers inside the 0.1..0.9 band', () => {
        for (const v of Object.values(personalityToTraits(preset.personality))) {
          expect(v).toBeGreaterThanOrEqual(0.1);
          expect(v).toBeLessThanOrEqual(0.9);
        }
      });
    });
  }

  it('AgentPresetSchema rejects an unknown skill shape and an out-of-band slider', () => {
    const base = getPreset('assistant') as AgentPreset;
    expect(() => AgentPresetSchema.parse({ ...base, personality: { warmth: 2 } })).toThrow();
    expect(() => AgentPresetSchema.parse({ ...base, skills: 'reminders' })).toThrow();
    expect(() =>
      AgentPresetSchema.parse({ ...base, agentLoop: { every: '1h', mode: 'x' } })
    ).toThrow();
  });
});

describe('applyPreset', () => {
  const researcher = getPreset('researcher') as AgentPreset;

  it('fills every preset field when the input only carries an id', () => {
    const out = applyPreset(researcher, { id: 'scout' });
    expect(out.id).toBe('scout');
    expect(out.preset).toBe('researcher');
    expect(out.name).toBe(researcher.name);
    expect(out.purpose).toBe(researcher.purpose);
    expect(out.personality).toEqual(researcher.personality);
    expect(out.quirks).toBe(researcher.quirks);
    expect(out.emoji).toBe(researcher.emoji);
    expect(out.skills).toEqual(researcher.skills);
    expect(out.disabledTools).toEqual(researcher.disabledTools);
    expect(out.agentLoop).toEqual(researcher.agentLoop);
  });

  it('never clobbers what the user typed — including empty strings and empty arrays', () => {
    const input = {
      id: 'scout',
      name: 'Scout',
      purpose: 'My own purpose.',
      quirks: '',
      emoji: '',
      skills: [] as string[],
      disabledTools: [] as string[],
      token: 'abc',
      enabled: false,
    };
    const out = applyPreset(researcher, input);
    expect(out.name).toBe('Scout');
    expect(out.purpose).toBe('My own purpose.');
    expect(out.quirks).toBe('');
    expect(out.emoji).toBe('');
    expect(out.skills).toEqual([]);
    expect(out.disabledTools).toEqual([]);
    expect(out.token).toBe('abc');
    expect(out.enabled).toBe(false);
    // agentLoop was not given, so the preset's cadence applies
    expect(out.agentLoop).toEqual(researcher.agentLoop);
  });

  it('merges objects per key: a partial personality or agentLoop keeps the rest from the preset', () => {
    const out = applyPreset(researcher, {
      id: 'x',
      personality: { warmth: 0.05 },
      agentLoop: { every: '15m' },
    });
    expect(out.personality).toEqual({ ...researcher.personality, warmth: 0.05 });
    expect(out.agentLoop).toEqual({ ...researcher.agentLoop, every: '15m' });
  });

  it('is pure: the input and the preset are untouched, and it survives null fields', () => {
    const input = { id: 'x', personality: null, agentLoop: undefined } as Record<string, unknown>;
    const snapshot = JSON.stringify(researcher);
    const out = applyPreset(researcher, input);
    expect(out).not.toBe(input);
    expect(input.personality).toBeNull();
    expect(out.personality).toEqual(researcher.personality);
    expect(JSON.stringify(researcher)).toBe(snapshot);
    out.skills.push('zzz');
    expect(researcher.skills).not.toContain('zzz');
  });
});

describe('presetSummary / presetToTemplateConfig', () => {
  it('summary is what GET /api/agents/presets returns: id, name, emoji, description and the prefill', () => {
    const s = presetSummary(getPreset('coder') as AgentPreset);
    expect(Object.keys(s).sort()).toEqual(
      [
        'id',
        'name',
        'emoji',
        'description',
        'purpose',
        'personality',
        'quirks',
        'skills',
        'disabledTools',
        'agentLoop',
        'goals',
      ].sort()
    );
    expect(s.goals.every((g) => typeof g.text === 'string')).toBe(true);
  });

  it('template config carries the reusable subset for the multi-tenant TemplateService', () => {
    const t = presetToTemplateConfig(getPreset('social') as AgentPreset);
    expect(t.name).toBe((getPreset('social') as AgentPreset).name);
    expect(t.skills).toEqual((getPreset('social') as AgentPreset).skills);
    expect(t.tools?.disabled).toEqual((getPreset('social') as AgentPreset).disabledTools);
    expect(t.agentLoop).toEqual((getPreset('social') as AgentPreset).agentLoop);
    expect(t.description).toContain((getPreset('social') as AgentPreset).description);
  });
});

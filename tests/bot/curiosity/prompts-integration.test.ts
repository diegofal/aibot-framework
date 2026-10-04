import { describe, expect, it } from 'bun:test';
import {
  buildContinuousPlannerPrompt,
  buildPlannerPrompt,
  buildStrategistPrompt,
} from '../../../src/bot/agent-loop-prompts';

const base = {
  identity: 'I',
  soul: 'S',
  motivations: 'M',
  goals: 'G',
  recentMemory: '',
  datetime: '2026-10-03',
  availableTools: ['web_search'],
  hasCreateTool: false,
};
const BLOCK = '## Your DNA\n\nCURIOUS — chase surprise';

describe('planner prompts with the curiosity block', () => {
  for (const [name, build] of [
    ['periodic', buildPlannerPrompt],
    ['continuous', buildContinuousPlannerPrompt],
  ] as const) {
    it(`${name}: injects the DNA block and swaps the inaction rule for purpose alignment`, () => {
      const { system } = build({ ...base, curiosityBlock: BLOCK });
      expect(system).toContain(BLOCK);
      expect(system).toContain('PURPOSE ALIGNMENT');
      expect(system).not.toContain('If unsure, choose inaction');
      expect(system).not.toContain('Creative exploration is allowed ONLY');
    });

    it(`${name}: keeps the legacy SOUL ALIGNMENT block without curiosity`, () => {
      const { system } = build({ ...base });
      expect(system).toContain('SOUL ALIGNMENT (non-negotiable)');
      expect(system).not.toContain('PURPOSE ALIGNMENT');
    });
  }
});

describe('strategist prompt with the curiosity block', () => {
  const sbase = {
    identity: 'I',
    soul: 'S',
    motivations: 'M',
    goals: 'G',
    recentMemory: '',
    datetime: 'd',
  };

  it('injects the block and lets exploration satisfy the engagement check', () => {
    const { system } = buildStrategistPrompt({ ...sbase, curiosityBlock: BLOCK });
    expect(system).toContain(BLOCK);
    expect(system).toContain('EXPLORATION');
    expect(system).not.toContain('Production without feedback is waste.');
  });

  it('is unchanged without the block', () => {
    const { system } = buildStrategistPrompt(sbase);
    expect(system).toContain('Production without feedback is waste.');
    expect(system).not.toContain(BLOCK);
  });
});

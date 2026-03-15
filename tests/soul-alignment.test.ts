import { describe, expect, test } from 'bun:test';
import {
  buildContinuousPlannerPrompt,
  buildExecutorPrompt,
  buildPlannerPrompt,
  buildStrategistPrompt,
} from '../src/bot/agent-loop-prompts';
import { parseStrategistResult } from '../src/bot/agent-strategist';

function makeLogger() {
  return {
    warn: () => {},
  } as unknown as import('../src/logger').Logger;
}

describe('Soul Alignment — Prompt Content', () => {
  test('buildPlannerPrompt includes SOUL ALIGNMENT block', () => {
    const { system } = buildPlannerPrompt({
      identity: 'A cooking assistant',
      soul: 'Expert in Italian cuisine',
      motivations: 'Help users cook better meals',
      goals: 'Teach pasta-making techniques',
      recentMemory: '',
      datetime: '2026-03-14',
      availableTools: ['web_search'],
      hasCreateTool: false,
    });
    expect(system).toContain('SOUL ALIGNMENT (non-negotiable)');
    expect(system).toContain('OFF-BRAND and BANNED');
  });

  test('buildContinuousPlannerPrompt includes SOUL ALIGNMENT block', () => {
    const { system } = buildContinuousPlannerPrompt({
      identity: 'A cooking assistant',
      soul: 'Expert in Italian cuisine',
      motivations: 'Help users cook better meals',
      goals: 'Teach pasta-making techniques',
      recentMemory: '',
      datetime: '2026-03-14',
      availableTools: ['web_search'],
      hasCreateTool: false,
    });
    expect(system).toContain('SOUL ALIGNMENT (non-negotiable)');
  });

  test('buildExecutorPrompt includes SOUL ALIGNMENT CHECK', () => {
    const prompt = buildExecutorPrompt({
      plan: ['Step 1'],
      identity: 'A cooking assistant',
      soul: 'Expert in Italian cuisine',
      motivations: 'Help users cook better meals',
      goals: 'Teach pasta-making techniques',
      datetime: '2026-03-14',
      hasCreateTool: false,
      workDir: './productions/test',
    });
    expect(prompt).toContain('SOUL ALIGNMENT CHECK');
    expect(prompt).toContain('verify it serves your stated identity');
  });

  test('buildStrategistPrompt includes soul alignment consideration', () => {
    const { system } = buildStrategistPrompt({
      identity: 'A cooking assistant',
      soul: 'Expert in Italian cuisine',
      motivations: 'Help users cook better meals',
      goals: 'Teach pasta-making techniques',
      recentMemory: '',
      datetime: '2026-03-14',
    });
    expect(system).toContain('Soul Alignment');
    expect(system).toContain('off-brand deliverable is worse than no deliverable');
  });

  test('buildStrategistPrompt schema includes alignment_confidence', () => {
    const { system } = buildStrategistPrompt({
      identity: 'A cooking assistant',
      soul: '',
      motivations: '',
      goals: '',
      recentMemory: '',
      datetime: '2026-03-14',
    });
    expect(system).toContain('alignment_confidence');
    expect(system).toContain('0.0-1.0');
  });
});

describe('Soul Alignment — Strategist Parsing', () => {
  test('parseStrategistResult extracts alignment_confidence', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Write a pasta recipe guide',
      alignment_confidence: 0.95,
      reflection: 'Aligned with cooking identity',
      next_strategy_in: '6h',
    });
    const result = parseStrategistResult(raw, makeLogger());
    expect(result).not.toBeNull();
    expect(result?.alignment_confidence).toBe(0.95);
  });

  test('parseStrategistResult handles missing alignment_confidence', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Write a recipe',
      reflection: 'On track',
    });
    const result = parseStrategistResult(raw, makeLogger());
    expect(result).not.toBeNull();
    expect(result?.alignment_confidence).toBeUndefined();
  });

  test('parseStrategistResult ignores invalid alignment_confidence values', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Write a recipe',
      alignment_confidence: 1.5, // out of range
      reflection: 'On track',
    });
    const result = parseStrategistResult(raw, makeLogger());
    expect(result).not.toBeNull();
    expect(result?.alignment_confidence).toBeUndefined();
  });

  test('parseStrategistResult ignores negative alignment_confidence', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Write a recipe',
      alignment_confidence: -0.5,
      reflection: 'On track',
    });
    const result = parseStrategistResult(raw, makeLogger());
    expect(result).not.toBeNull();
    expect(result?.alignment_confidence).toBeUndefined();
  });

  test('parseStrategistResult handles alignment_confidence at boundary 0.0', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Write a recipe',
      alignment_confidence: 0.0,
      reflection: 'Completely off brand',
    });
    const result = parseStrategistResult(raw, makeLogger());
    expect(result).not.toBeNull();
    expect(result?.alignment_confidence).toBe(0.0);
  });

  test('parseStrategistResult handles alignment_confidence at boundary 1.0', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Write a recipe',
      alignment_confidence: 1.0,
      reflection: 'Perfectly aligned',
    });
    const result = parseStrategistResult(raw, makeLogger());
    expect(result).not.toBeNull();
    expect(result?.alignment_confidence).toBe(1.0);
  });
});

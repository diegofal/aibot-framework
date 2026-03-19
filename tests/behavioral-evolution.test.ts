import { describe, expect, test } from 'bun:test';
import {
  type ActionType,
  type RecentAction,
  classifyAction,
  computeActionDiversity,
  detectUnconsumedOutput,
} from '../src/bot/agent-loop-utils';
import { computeTemporalWeight } from '../src/bot/soul-memory-consolidator';

// ── classifyAction ──

describe('classifyAction', () => {
  test('classifies content creation actions', () => {
    expect(classifyAction('Created file math_fractions.md')).toBe('CONTENT');
    expect(classifyAction('Write a new activity for Emma')).toBe('CONTENT');
    expect(classifyAction('Generated report on progress')).toBe('CONTENT');
    expect(classifyAction('Drafted LinkedIn headline update')).toBe('CONTENT');
    expect(classifyAction('file_write: produced daily summary')).toBe('CONTENT');
  });

  test('classifies outreach actions', () => {
    expect(classifyAction('Send message to Diego about progress')).toBe('OUTREACH');
    expect(classifyAction('Nudge operator for feedback')).toBe('OUTREACH');
    expect(classifyAction('ask_human: checking in with operator')).toBe('OUTREACH');
    expect(classifyAction('Sent proactive notification to user')).toBe('OUTREACH');
    expect(classifyAction('Contact Diego via Telegram')).toBe('OUTREACH');
  });

  test('classifies research actions', () => {
    expect(classifyAction('web_search: AI trends 2026')).toBe('RESEARCH');
    expect(classifyAction('Research competitor pricing')).toBe('RESEARCH');
    expect(classifyAction('web_fetch: reading article on LLMs')).toBe('RESEARCH');
    expect(classifyAction('Investigated job listings on LinkedIn')).toBe('RESEARCH');
    expect(classifyAction('Browse DeFi protocol documentation')).toBe('RESEARCH');
  });

  test('classifies assessment actions', () => {
    expect(classifyAction('Review impact of sent messages')).toBe('ASSESSMENT');
    expect(classifyAction('Evaluate student progress on fractions')).toBe('ASSESSMENT');
    expect(classifyAction('Audit current goal completion rate')).toBe('ASSESSMENT');
    expect(classifyAction('Test the retry mechanism')).toBe('ASSESSMENT');
    expect(classifyAction('Verify document accuracy')).toBe('ASSESSMENT');
  });

  test('classifies maintenance actions', () => {
    expect(classifyAction('Updated goals with new priority')).toBe('MAINTENANCE');
    expect(classifyAction('manage_goals: mark complete')).toBe('MAINTENANCE');
    expect(classifyAction('save_memory: stored new insight')).toBe('MAINTENANCE');
    expect(classifyAction('Consolidated daily memory logs')).toBe('MAINTENANCE');
    expect(classifyAction('update_soul: refined identity')).toBe('MAINTENANCE');
  });

  test('classifies idle actions', () => {
    expect(classifyAction('Idle — no novel action found')).toBe('IDLE');
    expect(classifyAction('No action taken, waiting for response')).toBe('IDLE');
    expect(classifyAction('Skipped cycle, nothing to do')).toBe('IDLE');
  });

  test('empty or null-ish strings return IDLE', () => {
    expect(classifyAction('')).toBe('IDLE');
    expect(classifyAction('   ')).toBe('IDLE');
  });

  test('ambiguous actions get a reasonable classification', () => {
    // "review" is assessment, should win over content
    expect(classifyAction('Review and update the document')).toBe('ASSESSMENT');
  });
});

// ── computeActionDiversity ──

describe('computeActionDiversity', () => {
  const makeActions = (summaries: string[]): RecentAction[] =>
    summaries.map((s, i) => ({
      cycle: i + 1,
      timestamp: Date.now() - (summaries.length - i) * 3600000,
      tools: [],
      planSummary: s,
    }));

  test('returns zero entropy for empty actions', () => {
    const result = computeActionDiversity([]);
    expect(result.entropy).toBe(0);
    expect(result.isRut).toBe(false);
  });

  test('returns zero entropy for all same type', () => {
    const actions = makeActions([
      'Created file A',
      'Created file B',
      'Created file C',
      'Writing document D',
      'Drafted report E',
    ]);
    const result = computeActionDiversity(actions);
    expect(result.entropy).toBe(0);
    expect(result.dominantType).toBe('CONTENT');
    expect(result.dominantPct).toBe(1);
    expect(result.isRut).toBe(true);
  });

  test('returns high entropy for diverse actions', () => {
    const actions = makeActions([
      'Created file A',
      'Send message to user',
      'web_search: latest trends',
      'Review impact of work',
      'Updated goals',
    ]);
    const result = computeActionDiversity(actions);
    expect(result.entropy).toBeGreaterThan(1.5);
    expect(result.isRut).toBe(false);
    expect(result.dominantPct).toBe(0.2);
  });

  test('detects behavioral rut when >70% same type', () => {
    const actions = makeActions([
      'Created file A',
      'Created file B',
      'Created file C',
      'Created file D',
      'Created file E',
      'Created file F',
      'Created file G',
      'Created file H',
      'Send message to user',
      'web_search: something',
    ]);
    const result = computeActionDiversity(actions);
    expect(result.dominantType).toBe('CONTENT');
    expect(result.dominantPct).toBe(0.8);
    expect(result.isRut).toBe(true);
  });

  test('detects rut via low entropy even if no single type >70%', () => {
    // All actions are essentially the same type (CONTENT) but phrased differently
    const actions = makeActions(['Created file A', 'Writing document B']);
    const result = computeActionDiversity(actions);
    expect(result.entropy).toBe(0);
    expect(result.isRut).toBe(true);
  });
});

// ── detectUnconsumedOutput ──

describe('detectUnconsumedOutput', () => {
  const makeActions = (summaries: string[]): RecentAction[] =>
    summaries.map((s, i) => ({
      cycle: i + 1,
      timestamp: Date.now() - (summaries.length - i) * 3600000,
      tools: [],
      planSummary: s,
    }));

  test('returns no gate trigger when no actions', () => {
    const result = detectUnconsumedOutput([], 5);
    expect(result.gateTriggered).toBe(false);
    expect(result.outputCount).toBe(0);
    expect(result.feedbackCount).toBe(0);
  });

  test('triggers gate when many outputs and no feedback', () => {
    const actions = makeActions([
      'Created file A',
      'Created file B',
      'Created file C',
      'Created file D',
      'Created file E',
      'Created file F',
    ]);
    const result = detectUnconsumedOutput(actions, 5);
    expect(result.gateTriggered).toBe(true);
    expect(result.outputCount).toBe(6);
    expect(result.feedbackCount).toBe(0);
  });

  test('does not trigger gate when feedback is present', () => {
    const actions = makeActions([
      'Created file A',
      'Created file B',
      'Created file C',
      'Created file D',
      'Created file E',
      'Received confirmation from user',
    ]);
    const result = detectUnconsumedOutput(actions, 5);
    expect(result.gateTriggered).toBe(false);
    expect(result.outputCount).toBe(5);
    expect(result.feedbackCount).toBe(1);
  });

  test('counts assessment actions as feedback', () => {
    const actions = makeActions([
      'Created file A',
      'Created file B',
      'Created file C',
      'Created file D',
      'Created file E',
      'Review impact of sent content',
    ]);
    const result = detectUnconsumedOutput(actions, 5);
    expect(result.gateTriggered).toBe(false);
    expect(result.feedbackCount).toBeGreaterThan(0);
  });

  test('respects custom threshold', () => {
    const actions = makeActions(['Created file A', 'Created file B', 'Created file C']);
    // threshold=2 should trigger
    const result = detectUnconsumedOutput(actions, 2);
    expect(result.gateTriggered).toBe(true);
    // threshold=5 should not trigger
    const result2 = detectUnconsumedOutput(actions, 5);
    expect(result2.gateTriggered).toBe(false);
  });

  test('computes ratio correctly', () => {
    const actions = makeActions([
      'Created file A',
      'Created file B',
      'Send message to user',
      'Received feedback from operator',
    ]);
    const result = detectUnconsumedOutput(actions, 5);
    expect(result.outputCount).toBe(3); // 2 content + 1 outreach
    expect(result.feedbackCount).toBe(1);
    expect(result.ratio).toBe(3);
  });
});

// ── computeTemporalWeight ──

describe('computeTemporalWeight', () => {
  test('returns 1.0 for today', () => {
    const now = new Date();
    const weight = computeTemporalWeight(now, 7);
    expect(weight).toBeCloseTo(1.0, 1);
  });

  test('returns ~0.5 at half-life', () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const weight = computeTemporalWeight(sevenDaysAgo, 7);
    expect(weight).toBeCloseTo(0.5, 1);
  });

  test('returns ~0.25 at 2x half-life', () => {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
    const weight = computeTemporalWeight(fourteenDaysAgo, 7);
    expect(weight).toBeCloseTo(0.25, 1);
  });

  test('returns very low weight for old entries', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    const weight = computeTemporalWeight(thirtyDaysAgo, 7);
    expect(weight).toBeLessThan(0.1);
  });

  test('respects custom half-life', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    const weight = computeTemporalWeight(threeDaysAgo, 3);
    expect(weight).toBeCloseTo(0.5, 1);
  });

  test('future dates return >1.0', () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    const weight = computeTemporalWeight(tomorrow, 7);
    expect(weight).toBeGreaterThan(1.0);
  });
});

// ── Integration: buildRecentActionsDigest includes diversity ──

describe('buildRecentActionsDigest with diversity', () => {
  const { buildRecentActionsDigest } = require('../src/bot/agent-loop-utils');

  test('includes action type distribution in digest', () => {
    const actions: RecentAction[] = [
      { cycle: 1, timestamp: Date.now() - 3600000, tools: [], planSummary: 'Created file A' },
      { cycle: 2, timestamp: Date.now() - 2400000, tools: [], planSummary: 'Created file B' },
      { cycle: 3, timestamp: Date.now() - 1200000, tools: [], planSummary: 'Created file C' },
    ];
    const digest = buildRecentActionsDigest(actions);
    expect(digest).toContain('Action types:');
    expect(digest).toContain('CONTENT');
    expect(digest).toContain('entropy=');
  });

  test('includes BEHAVIORAL RUT warning for monotonous actions', () => {
    const actions: RecentAction[] = Array.from({ length: 8 }, (_, i) => ({
      cycle: i + 1,
      timestamp: Date.now() - (8 - i) * 3600000,
      tools: [],
      planSummary: `Created file ${String.fromCharCode(65 + i)}`,
    }));
    const digest = buildRecentActionsDigest(actions);
    expect(digest).toContain('BEHAVIORAL RUT');
  });

  test('includes ENGAGEMENT GAP warning when many outputs without feedback', () => {
    const actions: RecentAction[] = Array.from({ length: 6 }, (_, i) => ({
      cycle: i + 1,
      timestamp: Date.now() - (6 - i) * 3600000,
      tools: [],
      planSummary: `Created file ${String.fromCharCode(65 + i)}`,
    }));
    const digest = buildRecentActionsDigest(actions);
    expect(digest).toContain('ENGAGEMENT GAP');
  });
});

// ── Config schema: engagementGate ──

describe('engagementGate config schema', () => {
  const { BotAgentLoopOverrideSchema } = require('../src/config');

  test('accepts valid engagementGate config', () => {
    const result = BotAgentLoopOverrideSchema.parse({
      engagementGate: { enabled: true, mode: 'hard', threshold: 3 },
    });
    expect(result.engagementGate.enabled).toBe(true);
    expect(result.engagementGate.mode).toBe('hard');
    expect(result.engagementGate.threshold).toBe(3);
  });

  test('uses defaults when not specified', () => {
    const result = BotAgentLoopOverrideSchema.parse({
      engagementGate: {},
    });
    expect(result.engagementGate.enabled).toBe(true);
    expect(result.engagementGate.mode).toBe('soft');
    expect(result.engagementGate.threshold).toBe(5);
  });

  test('accepts undefined engagementGate', () => {
    const result = BotAgentLoopOverrideSchema.parse({});
    expect(result.engagementGate).toBeUndefined();
  });
});

// ── Strategist prompt includes behavioral pattern analysis ──

describe('strategist prompt behavioral analysis', () => {
  const { buildStrategistPrompt } = require('../src/bot/agent-loop-prompts');

  test('includes behavioral pattern analysis section', () => {
    const { system } = buildStrategistPrompt({
      identity: 'Test bot',
      soul: 'Test soul',
      motivations: 'Test motivations',
      goals: 'Test goals',
      recentMemory: 'Test memory',
      datetime: '2026-03-18T12:00:00Z',
    });
    expect(system).toContain('Behavioral Pattern Analysis');
    expect(system).toContain('ENGAGEMENT CHECK');
  });

  test('includes behavioral state when provided', () => {
    const { system } = buildStrategistPrompt({
      identity: 'Test bot',
      soul: 'Test soul',
      motivations: 'Test motivations',
      goals: 'Test goals',
      recentMemory: 'Test memory',
      datetime: '2026-03-18T12:00:00Z',
      behavioralState:
        'Action diversity: entropy=0.12, dominant=CONTENT_CREATION (85%)\n⚠️ BEHAVIORAL RUT DETECTED',
    });
    expect(system).toContain('Current Behavioral State');
    expect(system).toContain('entropy=0.12');
    expect(system).toContain('BEHAVIORAL RUT DETECTED');
  });
});

// ── Planner prompt includes engagement gate ──

describe('planner prompt engagement gate', () => {
  const {
    buildPlannerPrompt,
    buildContinuousPlannerPrompt,
  } = require('../src/bot/agent-loop-prompts');

  const baseInput = {
    identity: 'Test bot',
    soul: 'Test soul',
    motivations: 'Test motivations',
    goals: 'Test goals',
    recentMemory: 'Test memory',
    datetime: '2026-03-18T12:00:00Z',
    availableTools: ['file_write', 'ask_human'],
    hasCreateTool: false,
  };

  test('includes engagement gate note in periodic planner', () => {
    const { system } = buildPlannerPrompt({
      ...baseInput,
      engagementGateNote: '## ⛔ ENGAGEMENT GATE (HARD)\n\nCONTENT CREATION IS BLOCKED',
    });
    expect(system).toContain('ENGAGEMENT GATE (HARD)');
    expect(system).toContain('CONTENT CREATION IS BLOCKED');
  });

  test('includes engagement gate note in continuous planner', () => {
    const { system } = buildContinuousPlannerPrompt({
      ...baseInput,
      engagementGateNote: '## ⚠️ ENGAGEMENT GATE (SOFT)\n\nConsider prioritizing ASSESSMENT',
    });
    expect(system).toContain('ENGAGEMENT GATE (SOFT)');
  });

  test('omits engagement gate when not provided', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).not.toContain('ENGAGEMENT GATE');
  });
});

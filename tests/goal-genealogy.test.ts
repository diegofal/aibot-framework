import { describe, expect, it } from 'bun:test';
import {
  type EnrichedGoalEntry,
  GoalGenealogy,
  parseGenealogyFields,
  serializeGenealogyFields,
} from '../src/bot/goal-genealogy';

describe('goal-genealogy', () => {
  const genealogy = new GoalGenealogy();

  // ── enrichSource ──

  describe('enrichSource', () => {
    it('parses strategist source', () => {
      const result = genealogy.enrichSource('strategist:2026-03-24');
      expect(result.origin).toBe('strategist');
    });

    it('parses reflection source', () => {
      const result = genealogy.enrichSource('reflection:2026-03-24');
      expect(result.origin).toBe('reflection');
    });

    it('extracts from= context', () => {
      const result = genealogy.enrichSource('strategist:2026-03-24:from=behavioral_rut');
      expect(result.origin).toBe('strategist');
      expect(result.originContext).toBe('behavioral_rut');
    });

    it('uses trigger context when provided', () => {
      const result = genealogy.enrichSource('strategist:2026-03-24', 'rss:new_article');
      expect(result.originContext).toBe('rss:new_article');
    });

    it('defaults to operator for unknown sources', () => {
      const result = genealogy.enrichSource(undefined);
      expect(result.origin).toBe('operator');
    });

    it('parses environment source', () => {
      expect(genealogy.enrichSource('environment:sensor').origin).toBe('environment');
      expect(genealogy.enrichSource('sensor:rss').origin).toBe('environment');
    });

    it('parses mesh source', () => {
      expect(genealogy.enrichSource('mesh:bot-a').origin).toBe('mesh');
      expect(genealogy.enrichSource('peer:bot-b').origin).toBe('mesh');
    });
  });

  // ── linkChild ──

  describe('linkChild', () => {
    it('links parent and child', () => {
      const parent: EnrichedGoalEntry = {
        text: 'Parent goal',
        status: 'in_progress',
        priority: 'high',
      };
      const child: EnrichedGoalEntry = {
        text: 'Child goal',
        status: 'pending',
        priority: 'medium',
      };

      genealogy.linkChild(parent, child, 'parent-1', 'child-1');
      expect(child.parentGoalId).toBe('parent-1');
      expect(parent.childGoalIds).toContain('child-1');
    });

    it('does not duplicate child links', () => {
      const parent: EnrichedGoalEntry = {
        text: 'Parent',
        status: 'in_progress',
        priority: 'high',
        childGoalIds: ['child-1'],
      };
      const child: EnrichedGoalEntry = {
        text: 'Child',
        status: 'pending',
        priority: 'medium',
      };

      genealogy.linkChild(parent, child, 'parent-1', 'child-1');
      expect(parent.childGoalIds).toHaveLength(1);
    });
  });

  // ── scoreOutcome ──

  describe('scoreOutcome', () => {
    it('gives full score for completed goal with consumption', () => {
      const goal: EnrichedGoalEntry = {
        text: 'Test',
        status: 'completed',
        priority: 'high',
        completed: '2026-03-24',
      };

      // Without ledger, score comes from karma + completion
      const score = genealogy.scoreOutcome(goal, null, undefined, true);
      // SCORE_KARMA_POSITIVE (0.2) + SCORE_ON_TIME (0.1) = 0.3
      expect(score).toBeCloseTo(0.3, 1);
    });

    it('returns 0 for uncompleted goal with no signals', () => {
      const goal: EnrichedGoalEntry = {
        text: 'Test',
        status: 'pending',
        priority: 'high',
      };
      const score = genealogy.scoreOutcome(goal, null, undefined, false);
      expect(score).toBe(0);
    });

    it('caps score at 1.0', () => {
      const goal: EnrichedGoalEntry = {
        text: 'Test',
        status: 'completed',
        priority: 'high',
        completed: '2026-03-24',
      };
      // Even with all signals positive, should not exceed 1.0
      const score = genealogy.scoreOutcome(goal, null, undefined, true);
      expect(score).toBeLessThanOrEqual(1.0);
    });
  });

  // ── getOriginStats ──

  describe('getOriginStats', () => {
    it('computes per-origin statistics', () => {
      const goals: EnrichedGoalEntry[] = [
        {
          text: 'A',
          status: 'completed',
          priority: 'high',
          origin: 'strategist',
          outcomeScore: 0.8,
        },
        {
          text: 'B',
          status: 'completed',
          priority: 'medium',
          origin: 'strategist',
          outcomeScore: 0.6,
        },
        { text: 'C', status: 'pending', priority: 'low', origin: 'strategist' },
        { text: 'D', status: 'completed', priority: 'high', origin: 'operator', outcomeScore: 0.9 },
        {
          text: 'E',
          status: 'completed',
          priority: 'high',
          origin: 'environment',
          outcomeScore: 0.7,
        },
        { text: 'F', status: 'pending', priority: 'medium', origin: 'environment' },
      ];

      const stats = genealogy.getOriginStats(goals);

      const strategist = stats.find((s) => s.origin === 'strategist');
      expect(strategist).toBeDefined();
      expect(strategist?.total).toBe(3);
      expect(strategist?.completed).toBe(2);
      expect(strategist?.successRate).toBeCloseTo(2 / 3, 2);
      expect(strategist?.avgScore).toBeCloseTo(0.7, 1);

      const operator = stats.find((s) => s.origin === 'operator');
      expect(operator?.successRate).toBe(1.0); // 1/1

      const environment = stats.find((s) => s.origin === 'environment');
      expect(environment?.total).toBe(2);
      expect(environment?.completed).toBe(1);
    });

    it('sorts by success rate (highest first)', () => {
      const goals: EnrichedGoalEntry[] = [
        { text: 'A', status: 'pending', priority: 'high', origin: 'strategist' },
        { text: 'B', status: 'completed', priority: 'high', origin: 'operator' },
      ];
      const stats = genealogy.getOriginStats(goals);
      expect(stats[0].origin).toBe('operator');
    });

    it('handles empty goals', () => {
      const stats = genealogy.getOriginStats([]);
      expect(stats).toHaveLength(0);
    });

    it('defaults to operator for goals without origin', () => {
      const goals: EnrichedGoalEntry[] = [{ text: 'A', status: 'completed', priority: 'high' }];
      const stats = genealogy.getOriginStats(goals);
      expect(stats[0].origin).toBe('operator');
    });
  });

  // ── propagateScore ──

  describe('propagateScore', () => {
    it('propagates child scores to parent', () => {
      const parent: EnrichedGoalEntry = {
        text: 'Parent',
        status: 'completed',
        priority: 'high',
        outcomeScore: 0.5,
        childGoalIds: ['child-1', 'child-2'],
      };
      const child1: EnrichedGoalEntry = {
        text: 'Child 1',
        status: 'completed',
        priority: 'medium',
        outcomeScore: 0.8,
      };
      const child2: EnrichedGoalEntry = {
        text: 'Child 2',
        status: 'completed',
        priority: 'medium',
        outcomeScore: 0.6,
      };

      const goalMap = new Map<string, EnrichedGoalEntry>();
      goalMap.set('parent-1', parent);
      goalMap.set('child-1', child1);
      goalMap.set('child-2', child2);

      genealogy.propagateScore([parent], goalMap);
      // Parent score = (0.5 + avg(0.8, 0.6)) / 2 = (0.5 + 0.7) / 2 = 0.6
      expect(parent.outcomeScore).toBeCloseTo(0.6, 1);
    });
  });

  // ── renderForPrompt ──

  describe('renderForPrompt', () => {
    it('renders formatted stats', () => {
      const goals: EnrichedGoalEntry[] = [
        {
          text: 'A',
          status: 'completed',
          priority: 'high',
          origin: 'strategist',
          outcomeScore: 0.8,
        },
        { text: 'B', status: 'pending', priority: 'medium', origin: 'operator' },
      ];

      const result = genealogy.renderForPrompt(goals);
      expect(result).toContain('## Goal Performance by Origin');
      expect(result).toContain('strategist');
      expect(result).toContain('operator');
    });

    it('returns null for empty goals', () => {
      expect(genealogy.renderForPrompt([])).toBeNull();
    });
  });

  // ── Serialization ──

  describe('serializeGenealogyFields', () => {
    it('serializes all fields', () => {
      const goal: EnrichedGoalEntry = {
        text: 'Test',
        status: 'pending',
        priority: 'high',
        origin: 'strategist',
        originContext: 'behavioral_rut',
        parentGoalId: 'parent-1',
        outcomeScore: 0.75,
      };

      const lines = serializeGenealogyFields(goal);
      expect(lines).toContain('  - origin: strategist');
      expect(lines).toContain('  - origin_context: behavioral_rut');
      expect(lines).toContain('  - parent: parent-1');
      expect(lines).toContain('  - outcome_score: 0.75');
    });

    it('skips undefined fields', () => {
      const goal: EnrichedGoalEntry = {
        text: 'Test',
        status: 'pending',
        priority: 'high',
      };
      const lines = serializeGenealogyFields(goal);
      expect(lines).toHaveLength(0);
    });
  });

  describe('parseGenealogyFields', () => {
    it('parses all fields', () => {
      const fields = parseGenealogyFields({
        origin: 'environment',
        origin_context: 'rss:new_article',
        parent: 'parent-1',
        outcome_score: '0.85',
      });
      expect(fields.origin).toBe('environment');
      expect(fields.originContext).toBe('rss:new_article');
      expect(fields.parentGoalId).toBe('parent-1');
      expect(fields.outcomeScore).toBeCloseTo(0.85, 2);
    });

    it('returns empty for no fields', () => {
      const fields = parseGenealogyFields({});
      expect(fields.origin).toBeUndefined();
    });
  });
});

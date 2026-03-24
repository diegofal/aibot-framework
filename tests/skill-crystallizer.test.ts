import { describe, expect, it } from 'bun:test';
import type { RecentAction } from '../src/bot/agent-loop-utils';
import {
  SkillCrystallizer,
  containsWriteOperations,
  detectPatterns,
  generateToolDescription,
  generateToolName,
  isReadOnlySequence,
} from '../src/bot/skill-crystallizer';

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
} as any;

function makeAction(tools: string[], summary: string, hoursAgo = 0): RecentAction {
  return {
    cycle: 1,
    timestamp: Date.now() - hoursAgo * 3_600_000,
    tools,
    planSummary: summary,
  };
}

describe('skill-crystallizer', () => {
  // ── Pattern Detection ──

  describe('detectPatterns', () => {
    it('detects repeated 2-tool sequences', () => {
      const actions: RecentAction[] = [];
      for (let i = 0; i < 5; i++) {
        actions.push(makeAction(['web_search', 'web_fetch'], `Research task ${i}`));
      }

      const patterns = detectPatterns(actions);
      expect(patterns.length).toBeGreaterThan(0);

      const target = patterns.find(
        (p) => p.tools[0] === 'web_search' && p.tools[1] === 'web_fetch'
      );
      expect(target).toBeDefined();
      expect(target?.count).toBe(5);
    });

    it('requires minimum 4 occurrences', () => {
      const actions: RecentAction[] = [];
      for (let i = 0; i < 3; i++) {
        actions.push(makeAction(['web_search', 'web_fetch'], `Task ${i}`));
      }

      const patterns = detectPatterns(actions);
      expect(patterns).toHaveLength(0);
    });

    it('detects longer sequences (3+ tools)', () => {
      const actions: RecentAction[] = [];
      for (let i = 0; i < 5; i++) {
        actions.push(
          makeAction(['web_search', 'web_fetch', 'file_write'], `Research and write ${i}`)
        );
      }

      const patterns = detectPatterns(actions);
      // Should find both 2-grams and 3-gram
      const threeGram = patterns.find((p) => p.tools.length === 3);
      expect(threeGram).toBeDefined();
      expect(threeGram?.tools).toEqual(['web_search', 'web_fetch', 'file_write']);
    });

    it('prioritizes longer sequences', () => {
      const actions: RecentAction[] = [];
      for (let i = 0; i < 5; i++) {
        actions.push(makeAction(['web_search', 'web_fetch', 'file_write'], `Task ${i}`));
      }

      const patterns = detectPatterns(actions);
      // First pattern should be the longest
      expect(patterns[0].tools.length).toBeGreaterThanOrEqual(
        patterns[patterns.length - 1].tools.length
      );
    });

    it('filters by time window', () => {
      const actions: RecentAction[] = [];
      for (let i = 0; i < 5; i++) {
        actions.push(makeAction(['web_search', 'web_fetch'], `Task ${i}`, 24 * 8)); // 8 days ago
      }

      const patterns = detectPatterns(actions, 7 * 24 * 3_600_000);
      expect(patterns).toHaveLength(0);
    });

    it('skips single-tool actions', () => {
      const actions: RecentAction[] = [];
      for (let i = 0; i < 10; i++) {
        actions.push(makeAction(['web_search'], `Search ${i}`));
      }

      const patterns = detectPatterns(actions);
      expect(patterns).toHaveLength(0);
    });

    it('collects sample summaries', () => {
      const actions: RecentAction[] = [];
      for (let i = 0; i < 5; i++) {
        actions.push(makeAction(['web_search', 'web_fetch'], `Research topic ${i}`));
      }

      const patterns = detectPatterns(actions);
      const target = patterns[0];
      expect(target.sampleSummaries.length).toBeGreaterThan(0);
      expect(target.sampleSummaries.length).toBeLessThanOrEqual(3);
    });
  });

  // ── Safety checks ──

  describe('isReadOnlySequence', () => {
    it('returns true for read-only tools', () => {
      expect(isReadOnlySequence(['web_search', 'web_fetch', 'memory_search'])).toBe(true);
    });

    it('returns false for write tools', () => {
      expect(isReadOnlySequence(['web_search', 'file_write'])).toBe(false);
    });
  });

  describe('containsWriteOperations', () => {
    it('detects write operations', () => {
      expect(containsWriteOperations(['web_search', 'file_write'])).toBe(true);
      expect(containsWriteOperations(['send_message'])).toBe(true);
      expect(containsWriteOperations(['update_soul'])).toBe(true);
    });

    it('returns false for read-only', () => {
      expect(containsWriteOperations(['web_search', 'web_fetch'])).toBe(false);
    });
  });

  // ── Name generation ──

  describe('generateToolName', () => {
    it('generates snake_case name from pattern', () => {
      const name = generateToolName({
        tools: ['web_search', 'web_fetch'],
        count: 5,
        lastSeen: Date.now(),
        sampleSummaries: [],
      });
      expect(name).toBe('crystallized_web_search_then_web_fetch');
    });

    it('deduplicates repeated tools', () => {
      const name = generateToolName({
        tools: ['web_search', 'web_search', 'web_fetch'],
        count: 5,
        lastSeen: Date.now(),
        sampleSummaries: [],
      });
      expect(name).toBe('crystallized_web_search_then_web_fetch');
    });

    it('truncates long names', () => {
      const name = generateToolName({
        tools: ['very_long_tool_name_one', 'very_long_tool_name_two', 'very_long_tool_name_three'],
        count: 5,
        lastSeen: Date.now(),
        sampleSummaries: [],
      });
      expect(name.length).toBeLessThanOrEqual(60);
    });
  });

  // ── Description generation ──

  describe('generateToolDescription', () => {
    it('includes step list and samples', () => {
      const desc = generateToolDescription({
        tools: ['web_search', 'web_fetch'],
        count: 5,
        lastSeen: Date.now(),
        sampleSummaries: ['Research topic X', 'Investigate Y'],
      });
      expect(desc).toContain('1. web_search');
      expect(desc).toContain('2. web_fetch');
      expect(desc).toContain('5x observed');
      expect(desc).toContain('Research topic X');
    });
  });

  // ── SkillCrystallizer ──

  describe('SkillCrystallizer', () => {
    it('returns empty when no DynamicToolStore', () => {
      const crystallizer = new SkillCrystallizer(null, nullLogger);
      const proposals = crystallizer.analyze('test-bot', []);
      expect(proposals).toHaveLength(0);
    });

    it('analyzes and returns proposals', () => {
      const mockStore = {
        list: () => [],
        create: () => ({ id: 'test', name: 'test', status: 'pending' }),
      } as any;

      const crystallizer = new SkillCrystallizer(mockStore, nullLogger);
      const actions: RecentAction[] = [];
      for (let i = 0; i < 5; i++) {
        actions.push(makeAction(['web_search', 'web_fetch'], `Task ${i}`));
      }

      const proposals = crystallizer.analyze('test-bot', actions);
      expect(proposals.length).toBeGreaterThan(0);
      expect(proposals[0].proposedName).toContain('crystallized_');
    });

    it('limits to MAX_PROPOSALS_PER_RUN', () => {
      const mockStore = { list: () => [] } as any;
      const crystallizer = new SkillCrystallizer(mockStore, nullLogger);

      const actions: RecentAction[] = [];
      // Create two different patterns, each with 5+ occurrences
      for (let i = 0; i < 5; i++) {
        actions.push(makeAction(['web_search', 'web_fetch'], `Pattern A ${i}`));
        actions.push(makeAction(['memory_search', 'file_read'], `Pattern B ${i}`));
      }

      const proposals = crystallizer.analyze('test-bot', actions);
      expect(proposals.length).toBeLessThanOrEqual(1); // MAX_PROPOSALS_PER_RUN = 1
    });

    it('does not re-propose already proposed tools', () => {
      const mockStore = { list: () => [] } as any;
      const crystallizer = new SkillCrystallizer(mockStore, nullLogger);

      const actions: RecentAction[] = [];
      for (let i = 0; i < 5; i++) {
        actions.push(makeAction(['web_search', 'web_fetch'], `Task ${i}`));
      }

      // First call proposes
      const first = crystallizer.analyze('test-bot', actions);
      expect(first.length).toBe(1);

      // Second call should not re-propose same pattern
      const second = crystallizer.analyze('test-bot', actions);
      // May find other sub-patterns, but not the same one
      const sameName = second.find((p) => p.proposedName === first[0].proposedName);
      expect(sameName).toBeUndefined();
    });

    it('renders crystallization context for prompt', () => {
      const crystallizer = new SkillCrystallizer(null, nullLogger);
      const actions: RecentAction[] = [];
      for (let i = 0; i < 5; i++) {
        actions.push(makeAction(['web_search', 'web_fetch'], `Task ${i}`));
      }

      const rendered = crystallizer.renderForPrompt('test-bot', actions);
      expect(rendered).toContain('## Crystallization Candidates');
      expect(rendered).toContain('web_search → web_fetch');
    });

    it('returns null when no patterns', () => {
      const crystallizer = new SkillCrystallizer(null, nullLogger);
      expect(crystallizer.renderForPrompt('test-bot', [])).toBeNull();
    });
  });
});

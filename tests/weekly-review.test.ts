import { describe, it, expect, beforeEach } from 'bun:test';
import * as weeklyReviewModule from '../productions/makemylifeeasier/src/skills/weekly-review/index';
import type { SkillContext } from '../src/core/types';

// Access handlers from the module
const { handlers } = weeklyReviewModule as any;

/**
 * Unit tests for Weekly Review skill
 * 
 * Tests edge cases in cross-skill data aggregation:
 * - Empty/missing data from other skills (new user scenario)
 * - Partial data (some skills have data, others don't)
 * - Malformed data handling
 */
describe('Weekly Review - review_summary', () => {
  let mockContext: SkillContext;
  let dataStore: Map<string, unknown>;

  beforeEach(() => {
    dataStore = new Map();
    mockContext = {
      skillId: 'weekly-review',
      config: {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => mockContext.logger,
      },
      data: {
        get: <T>(key: string): T | undefined => dataStore.get(key) as T | undefined,
        set: <T>(key: string, value: T): void => { dataStore.set(key, value); },
        delete: (key: string): void => { dataStore.delete(key); },
        clear: (): void => { dataStore.clear(); },
      },
      ollama: {} as any,
      telegram: {} as any,
      tools: {} as any,
    };
  });

  describe('Empty/missing data scenarios', () => {
    it('should handle completely empty data store (new user)', async () => {
      // No data set - simulates brand new user with no prior activity
      const result = await handlers.review_summary({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      
      const summary = result.data as {
        prioritiesCompleted: number;
        prioritiesTotal: number;
        prioritiesRate: number;
        tasksCompleted: number;
        tasksTotal: number;
        tasksRate: number;
        streaksMaintained: number;
        streaksTotal: number;
        streaksRate: number;
        dailyPriorities: unknown[];
      };

      // All counts should be zero
      expect(summary.prioritiesCompleted).toBe(0);
      expect(summary.prioritiesTotal).toBe(0);
      expect(summary.prioritiesRate).toBe(0);
      expect(summary.tasksCompleted).toBe(0);
      expect(summary.tasksTotal).toBe(0);
      expect(summary.tasksRate).toBe(0);
      expect(summary.streaksMaintained).toBe(0);
      expect(summary.streaksTotal).toBe(0);
      expect(summary.streaksRate).toBe(0);
      expect(summary.dailyPriorities).toHaveLength(7);
    });

    it('should handle empty priorities data structure', async () => {
      // Priorities skill exists but has no days data
      dataStore.set('priorities_data', { days: {} });

      const result = await handlers.review_summary({}, mockContext);
      expect(result.success).toBe(true);
      
      const summary = result.data as {
        daysWithPriorities: number;
        daysWithReflection: number;
        prioritiesCompleted: number;
        prioritiesTotal: number;
      };

      expect(summary.daysWithPriorities).toBe(0);
      expect(summary.daysWithReflection).toBe(0);
      expect(summary.prioritiesCompleted).toBe(0);
      expect(summary.prioritiesTotal).toBe(0);
    });

    it('should handle empty tasks data structure', async () => {
      // Tasks skill exists but has no tasks
      dataStore.set('tasks_data', { tasks: [] });

      const result = await handlers.review_summary({}, mockContext);
      expect(result.success).toBe(true);
      
      const summary = result.data as {
        tasksCompleted: number;
        tasksTotal: number;
        tasksByPriority: Record<string, unknown>;
        overdueTasks: unknown[];
      };

      expect(summary.tasksCompleted).toBe(0);
      expect(summary.tasksTotal).toBe(0);
      expect(summary.tasksByPriority).toBeDefined();
      expect(summary.overdueTasks).toHaveLength(0);
    });

    it('should handle empty streaks data structure', async () => {
      // Streaks skill exists but has no habits
      dataStore.set('streak_data', { habits: {} });

      const result = await handlers.review_summary({}, mockContext);
      expect(result.success).toBe(true);
      
      const summary = result.data as {
        streaksMaintained: number;
        streaksTotal: number;
        habitStats: unknown[];
      };

      expect(summary.streaksMaintained).toBe(0);
      expect(summary.streaksTotal).toBe(0);
      expect(summary.habitStats).toHaveLength(0);
    });

    it('should handle partial data (only priorities exist)', async () => {
      const thisWeek = new Date().toISOString().split('T')[0];
      
      dataStore.set('priorities_data', {
        days: {
          [thisWeek]: {
            items: [
              { text: 'Priority 1', completed: true },
              { text: 'Priority 2', completed: false },
            ],
            reflection: 'Good day!',
          },
        },
      });
      // No tasks_data or streak_data set

      const result = await handlers.review_summary({}, mockContext);
      expect(result.success).toBe(true);
      
      const summary = result.data as {
        prioritiesCompleted: number;
        prioritiesTotal: number;
        tasksTotal: number;
        streaksTotal: number;
      };

      expect(summary.prioritiesCompleted).toBe(1);
      expect(summary.prioritiesTotal).toBe(2);
      expect(summary.tasksTotal).toBe(0); // No tasks data
      expect(summary.streaksTotal).toBe(0); // No streaks data
    });

    it('should handle partial data (only tasks exist)', async () => {
      const thisWeek = new Date().toISOString().split('T')[0];
      
      dataStore.set('tasks_data', {
        tasks: [
          {
            id: '1',
            title: 'Test task',
            priority: 'high',
            status: 'done',
            tags: ['work'],
            createdAt: thisWeek + 'T10:00:00Z',
            completedAt: thisWeek + 'T15:00:00Z',
          },
        ],
      });
      // No priorities_data or streak_data set

      const result = await handlers.review_summary({}, mockContext);
      expect(result.success).toBe(true);
      
      const summary = result.data as {
        tasksCompleted: number;
        tasksTotal: number;
        prioritiesTotal: number;
        streaksTotal: number;
      };

      expect(summary.tasksCompleted).toBe(1);
      expect(summary.tasksTotal).toBe(1);
      expect(summary.prioritiesTotal).toBe(0); // No priorities data
      expect(summary.streaksTotal).toBe(0); // No streaks data
    });

    it('should handle partial data (only streaks exist)', async () => {
      const thisWeek = new Date().toISOString().split('T')[0];
      
      dataStore.set('streak_data', {
        habits: {
          'habit-1': {
            name: 'Daily Exercise',
            frequency: 'daily',
            target: 7,
            completions: [thisWeek],
          },
        },
      });
      // No priorities_data or tasks_data set

      const result = await handlers.review_summary({}, mockContext);
      expect(result.success).toBe(true);
      
      const summary = result.data as {
        streaksMaintained: number;
        streaksTotal: number;
        habitStats: { name: string; completionsThisWeek: number }[];
        prioritiesTotal: number;
        tasksTotal: number;
      };

      expect(summary.streaksTotal).toBe(1);
      expect(summary.habitStats).toHaveLength(1);
      expect(summary.habitStats[0].name).toBe('Daily Exercise');
      expect(summary.prioritiesTotal).toBe(0); // No priorities data
      expect(summary.tasksTotal).toBe(0); // No tasks data
    });

    it('should calculate correct rates with zero denominators', async () => {
      // All empty - should not produce NaN or Infinity
      const result = await handlers.review_summary({}, mockContext);
      expect(result.success).toBe(true);
      
      const summary = result.data as {
        prioritiesRate: number;
        tasksRate: number;
        streaksRate: number;
        habitsHitRate: number;
      };

      // Rates should be 0, not NaN
      expect(summary.prioritiesRate).toBe(0);
      expect(summary.tasksRate).toBe(0);
      expect(summary.streaksRate).toBe(0);
      expect(summary.habitsHitRate).toBe(0);

      // Verify they're actually numbers, not NaN
      expect(Number.isNaN(summary.prioritiesRate)).toBe(false);
      expect(Number.isNaN(summary.tasksRate)).toBe(false);
      expect(Number.isNaN(summary.streaksRate)).toBe(false);
      expect(Number.isNaN(summary.habitsHitRate)).toBe(false);
    });
  });

  describe('Data isolation', () => {
    it('should not modify source skill data', async () => {
      const thisWeek = new Date().toISOString().split('T')[0];
      const originalPriorities = {
        days: {
          [thisWeek]: {
            items: [
              { text: 'Test', completed: false },
            ],
          },
        },
      };
      
      dataStore.set('priorities_data', JSON.parse(JSON.stringify(originalPriorities)));

      await handlers.review_summary({}, mockContext);

      // Verify original data is unchanged
      const storedData = dataStore.get('priorities_data') as typeof originalPriorities;
      expect(storedData.days[thisWeek].items[0].completed).toBe(false);
    });
  });
});

describe('Weekly Review - review_start', () => {
  let mockContext: SkillContext;
  let dataStore: Map<string, unknown>;

  beforeEach(() => {
    dataStore = new Map();
    mockContext = {
      skillId: 'weekly-review',
      config: {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => mockContext.logger,
      },
      data: {
        get: <T>(key: string): T | undefined => dataStore.get(key) as T | undefined,
        set: <T>(key: string, value: T): void => { dataStore.set(key, value); },
        delete: (key: string): void => { dataStore.delete(key); },
        clear: (): void => { dataStore.clear(); },
      },
      ollama: {} as any,
      telegram: {} as any,
      tools: {} as any,
    };
  });

  it('should create a new review for the current week', async () => {
    const result = await handlers.review_start({}, mockContext);
    
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    
    const review = result.data as {
      weekStart: string;
      weekEnd: string;
      wins: unknown[];
      challenges: unknown[];
      learnings: unknown[];
      nextWeekFocus: unknown[];
    };

    expect(review.weekStart).toBeDefined();
    expect(review.weekEnd).toBeDefined();
    expect(review.wins).toEqual([]);
    expect(review.challenges).toEqual([]);
    expect(review.learnings).toEqual([]);
    expect(review.nextWeekFocus).toEqual([]);
  });

  it('should return existing review if already created', async () => {
    // Create first review
    const firstResult = await handlers.review_start({}, mockContext);
    expect(firstResult.success).toBe(true);

    // Try to create again for same week
    const secondResult = await handlers.review_start({}, mockContext);
    expect(secondResult.success).toBe(true);
    expect(secondResult.message).toContain('already exists');
    expect(secondResult.data).toEqual(firstResult.data);
  });
});

describe('Weekly Review - review_save', () => {
  let mockContext: SkillContext;
  let dataStore: Map<string, unknown>;

  beforeEach(() => {
    dataStore = new Map();
    mockContext = {
      skillId: 'weekly-review',
      config: {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => mockContext.logger,
      },
      data: {
        get: <T>(key: string): T | undefined => dataStore.get(key) as T | undefined,
        set: <T>(key: string, value: T): void => { dataStore.set(key, value); },
        delete: (key: string): void => { dataStore.delete(key); },
        clear: (): void => { dataStore.clear(); },
      },
      ollama: {} as any,
      telegram: {} as any,
      tools: {} as any,
    };
  });

  it('should auto-create review if not exists when saving', async () => {
    const result = await handlers.review_save(
      { wins: ['Great week!'] },
      mockContext
    );
    
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    
    const review = result.data as { wins: string[] };
    expect(review.wins).toEqual(['Great week!']);
  });

  it('should replace arrays when saving', async () => {
    // First save
    await handlers.review_save({ wins: ['First win'] }, mockContext);
    
    // Second save - replaces the array
    const result = await handlers.review_save({ wins: ['Second win'] }, mockContext);
    
    const review = result.data as { wins: string[] };
    // Implementation replaces, not appends
    expect(review.wins).toEqual(['Second win']);
  });
});

describe('Weekly Review - review_history', () => {
  let mockContext: SkillContext;
  let dataStore: Map<string, unknown>;

  beforeEach(() => {
    dataStore = new Map();
    mockContext = {
      skillId: 'weekly-review',
      config: {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => mockContext.logger,
      },
      data: {
        get: <T>(key: string): T | undefined => dataStore.get(key) as T | undefined,
        set: <T>(key: string, value: T): void => { dataStore.set(key, value); },
        delete: (key: string): void => { dataStore.delete(key); },
        clear: (): void => { dataStore.clear(); },
      },
      ollama: {} as any,
      telegram: {} as any,
      tools: {} as any,
    };
  });

  it('should return empty array when no reviews exist', async () => {
    const result = await handlers.review_history({}, mockContext);
    
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('should return reviews sorted by date descending', async () => {
    // Create reviews for different weeks
    await handlers.review_start({ week_start: '2024-01-01' }, mockContext);
    await handlers.review_start({ week_start: '2024-01-08' }, mockContext);
    await handlers.review_start({ week_start: '2024-01-15' }, mockContext);

    const result = await handlers.review_history({ count: 3 }, mockContext);
    const reviews = result.data as { weekStart: string }[];
    
    expect(reviews).toHaveLength(3);
    expect(reviews[0].weekStart).toBe('2024-01-15'); // Most recent first
    expect(reviews[1].weekStart).toBe('2024-01-08');
    expect(reviews[2].weekStart).toBe('2024-01-01');
  });
});

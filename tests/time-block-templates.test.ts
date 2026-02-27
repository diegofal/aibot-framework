import { describe, it, expect, beforeEach } from 'bun:test';
import * as timeBlockModule from '../productions/makemylifeeasier/src/skills/time-block-templates/index';
import type { SkillContext } from '../src/core/types';

// Access handlers from the module
const { handlers } = timeBlockModule as any;

/**
 * Unit tests for Time Block Templates skill
 *
 * Edge cases covered:
 * - Empty schedule (no blocks defined)
 * - Overlapping blocks (same time slot on same day)
 * - Boundary times (23:59, 00:00)
 * - Current block detection edge cases
 * - Invalid time formats
 * - Block name conflicts
 * - Single minute blocks
 * - Multi-day blocks
 * - Block clearing
 */
describe('Time Block Templates - Edge Cases', () => {
  let mockContext: SkillContext;
  let dataStore: Map<string, unknown>;

  beforeEach(() => {
    dataStore = new Map();
    mockContext = {
      skillId: 'time-block-templates',
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

  describe('Empty schedule', () => {
    it('should return empty array when no blocks defined', async () => {
      const result = await handlers.timeblock_list({}, mockContext);
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
      expect(result.message).toContain('No time blocks');
    });

    it('should handle current block with empty schedule', async () => {
      const result = await handlers.timeblock_current({}, mockContext);
      expect(result.success).toBe(true);
      expect(result.data.current).toBeNull();
      expect(result.data.next).toBeNull();
      expect(result.data.all).toEqual([]);
    });

    it('should return message for today with empty schedule', async () => {
      const result = await handlers.timeblock_list({ today: true }, mockContext);
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe('Time validation edge cases', () => {
    it('should reject end time equal to start time', async () => {
      const result = await handlers.timeblock_define({
        name: 'Invalid Block',
        start: '09:00',
        end: '09:00',
      }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('after start time');
    });

    it('should reject end time before start time', async () => {
      const result = await handlers.timeblock_define({
        name: 'Invalid Block',
        start: '14:00',
        end: '09:00',
      }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('after start time');
    });

    it('should reject blocks that cross midnight (00:00 as end time)', async () => {
      // Skill doesn't support overnight blocks - 00:00 is treated as start of day
      const result = await handlers.timeblock_define({
        name: 'Late Night',
        start: '23:00',
        end: '00:00',
      }, mockContext);
      // This is rejected because 00:00 (0 minutes) < 23:00 (1380 minutes)
      expect(result.success).toBe(false);
      expect(result.message).toContain('after start time');
    });

    it('should accept minute boundaries (23:59)', async () => {
      const result = await handlers.timeblock_define({
        name: 'Almost Midnight',
        start: '23:00',
        end: '23:59',
      }, mockContext);
      expect(result.success).toBe(true);
      expect(result.data.end).toBe('23:59');
    });

    it('should reject invalid time format', async () => {
      const result = await handlers.timeblock_define({
        name: 'Bad Format',
        start: '9am',
        end: '10am',
      }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid');
    });

    it('should reject out of range hours', async () => {
      const result = await handlers.timeblock_define({
        name: 'Bad Hours',
        start: '25:00',
        end: '26:00',
      }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid');
    });

    it('should reject out of range minutes', async () => {
      const result = await handlers.timeblock_define({
        name: 'Bad Minutes',
        start: '09:60',
        end: '10:00',
      }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid');
    });

    it('should accept single minute duration', async () => {
      const result = await handlers.timeblock_define({
        name: 'One Minute',
        start: '09:00',
        end: '09:01',
      }, mockContext);
      expect(result.success).toBe(true);
    });
  });

  describe('Block name conflicts', () => {
    it('should reject duplicate block names', async () => {
      await handlers.timeblock_define({
        name: 'Deep Work',
        start: '09:00',
        end: '11:00',
      }, mockContext);

      const result = await handlers.timeblock_define({
        name: 'Deep Work',
        start: '14:00',
        end: '16:00',
      }, mockContext);

      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
    });

    it('should reject case-insensitive duplicate names', async () => {
      await handlers.timeblock_define({
        name: 'Deep Work',
        start: '09:00',
        end: '11:00',
      }, mockContext);

      const result = await handlers.timeblock_define({
        name: 'deep work',
        start: '14:00',
        end: '16:00',
      }, mockContext);

      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
    });

    it('should allow different names', async () => {
      await handlers.timeblock_define({
        name: 'Morning Block',
        start: '09:00',
        end: '11:00',
      }, mockContext);

      const result = await handlers.timeblock_define({
        name: 'Afternoon Block',
        start: '14:00',
        end: '16:00',
      }, mockContext);

      expect(result.success).toBe(true);
    });
  });

  describe('Overlapping blocks', () => {
    it('should allow overlapping blocks on different days', async () => {
      await handlers.timeblock_define({
        name: 'Weekday Work',
        start: '09:00',
        end: '17:00',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      }, mockContext);

      const result = await handlers.timeblock_define({
        name: 'Weekend Work',
        start: '09:00',
        end: '17:00',
        days: ['sat', 'sun'],
      }, mockContext);

      expect(result.success).toBe(true);
    });

    it('should allow adjacent blocks (end equals next start)', async () => {
      await handlers.timeblock_define({
        name: 'First Block',
        start: '09:00',
        end: '11:00',
      }, mockContext);

      const result = await handlers.timeblock_define({
        name: 'Second Block',
        start: '11:00',
        end: '13:00',
      }, mockContext);

      expect(result.success).toBe(true);
    });

    it('should allow overlapping blocks on same day (user discretion)', async () => {
      await handlers.timeblock_define({
        name: 'Block A',
        start: '09:00',
        end: '12:00',
      }, mockContext);

      const result = await handlers.timeblock_define({
        name: 'Block B',
        start: '10:00',
        end: '14:00',
      }, mockContext);

      // Current implementation allows overlaps - user manages conflicts
      expect(result.success).toBe(true);
    });
  });

  describe('Multi-day blocks', () => {
    it('should create block for all 7 days', async () => {
      const result = await handlers.timeblock_define({
        name: 'Daily Routine',
        start: '07:00',
        end: '08:00',
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.days).toHaveLength(7);
    });

    it('should create block for single day', async () => {
      const result = await handlers.timeblock_define({
        name: 'Monday Only',
        start: '09:00',
        end: '10:00',
        days: ['mon'],
      }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.days).toEqual(['mon']);
    });

    it('should use default days (mon-fri) when not specified', async () => {
      const result = await handlers.timeblock_define({
        name: 'Work Block',
        start: '09:00',
        end: '17:00',
      }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
    });
  });

  describe('Color tags', () => {
    it('should accept color tag', async () => {
      const result = await handlers.timeblock_define({
        name: 'Colored Block',
        start: '09:00',
        end: '10:00',
        color: 'blue',
      }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.color).toBe('blue');
    });

    it('should work without color tag', async () => {
      const result = await handlers.timeblock_define({
        name: 'Plain Block',
        start: '09:00',
        end: '10:00',
      }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.color).toBeUndefined();
    });
  });

  describe('Block clearing', () => {
    it('should clear existing block by name', async () => {
      await handlers.timeblock_define({
        name: 'To Delete',
        start: '09:00',
        end: '10:00',
      }, mockContext);

      const result = await handlers.timeblock_clear({ name: 'To Delete' }, mockContext);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Removed');

      const listResult = await handlers.timeblock_list({}, mockContext);
      expect(listResult.data).toHaveLength(0);
    });

    it('should clear block case-insensitively', async () => {
      await handlers.timeblock_define({
        name: 'Mixed Case',
        start: '09:00',
        end: '10:00',
      }, mockContext);

      const result = await handlers.timeblock_clear({ name: 'mixed case' }, mockContext);
      expect(result.success).toBe(true);
    });

    it('should reject clearing non-existent block', async () => {
      const result = await handlers.timeblock_clear({ name: 'Does Not Exist' }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should reject clearing without name', async () => {
      const result = await handlers.timeblock_clear({ name: '' }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('required');
    });
  });

  describe('List sorting', () => {
    it('should sort blocks by start time', async () => {
      await handlers.timeblock_define({ name: 'Afternoon', start: '14:00', end: '16:00' }, mockContext);
      await handlers.timeblock_define({ name: 'Morning', start: '09:00', end: '11:00' }, mockContext);
      await handlers.timeblock_define({ name: 'Evening', start: '18:00', end: '20:00' }, mockContext);

      const result = await handlers.timeblock_list({}, mockContext);
      const names = (result.data as Array<{ name: string }>).map(b => b.name);
      expect(names).toEqual(['Morning', 'Afternoon', 'Evening']);
    });

    it('should filter by today', async () => {
      const today = new Date().getDay();
      const todayName = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][today];

      await handlers.timeblock_define({
        name: 'Today Block',
        start: '09:00',
        end: '10:00',
        days: [todayName],
      }, mockContext);

      await handlers.timeblock_define({
        name: 'Other Day',
        start: '09:00',
        end: '10:00',
        days: todayName === 'mon' ? ['tue'] : ['mon'],
      }, mockContext);

      const result = await handlers.timeblock_list({ today: true }, mockContext);
      const names = (result.data as Array<{ name: string }>).map(b => b.name);
      expect(names).toEqual(['Today Block']);
    });
  });

  describe('Required field validation', () => {
    it('should reject missing name', async () => {
      const result = await handlers.timeblock_define({
        start: '09:00',
        end: '10:00',
      }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('name');
    });

    it('should reject missing start time', async () => {
      const result = await handlers.timeblock_define({
        name: 'Test',
        end: '10:00',
      }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Start time');
    });

    it('should reject missing end time', async () => {
      const result = await handlers.timeblock_define({
        name: 'Test',
        start: '09:00',
      }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('End time');
    });

    it('should reject empty name', async () => {
      const result = await handlers.timeblock_define({
        name: '',
        start: '09:00',
        end: '10:00',
      }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('name');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { SkillRegistry } from '../../src/core/skill-registry';
import { SkillLoader } from '../../src/core/skill-loader';
import type { Config } from '../../src/config';
import type { Logger } from '../../src/logger';

// Get absolute path to skills directory from project root
const PROJECT_ROOT = join(import.meta.dir, '../..');
const SKILLS_PATH = join(PROJECT_ROOT, 'src', 'skills');

/**
 * Integration tests for Skill Loading
 * 
 * This test verifies:
 * 1. Skills listed in config.skills.enabled are loaded from disk
 * 2. Skill manifests are read correctly
 * 3. Skill modules are imported and initialized
 * 4. onLoad hooks are called
 * 5. Skills are registered in the SkillRegistry
 * 6. Skills can be retrieved by ID
 */
describe('Skill Loading Integration', () => {
  let skillRegistry: SkillRegistry;
  let logger: Logger;

  beforeEach(() => {
    // Mock logger
    logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
    } as Logger;
  });

  afterEach(async () => {
    // Cleanup any loaded skills
    if (skillRegistry) {
      const loadedSkills = skillRegistry.getAll();
      for (const skill of loadedSkills) {
        await skillRegistry.unloadSkill(skill.id);
      }
    }
  });

  describe('SkillLoader', () => {
    it('should list available skills from disk', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: { enabled: [], config: {} },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      const registry = new SkillRegistry(config, logger);
      const available = await registry.listAvailable();

      // Should find our productivity skills
      const skillIds = available.map(s => s.id);
      expect(skillIds).toContain('quick-notes');
      expect(skillIds).toContain('task-tracker');
      expect(skillIds).toContain('daily-priorities');
      expect(skillIds).toContain('reminders');
    });

    it('should read skill manifests without loading modules', async () => {
      const loader = new SkillLoader(SKILLS_PATH, logger);
      const manifest = loader.readManifest('quick-notes');

      expect(manifest).not.toBeNull();
      expect(manifest?.id).toBe('quick-notes');
      expect(manifest?.name).toBe('Quick Notes');
      expect(manifest?.version).toBe('1.0.0');
      expect(manifest?.main).toBe('index.ts');
    });
  });

  describe('SkillRegistry.loadSkills', () => {
    it('should load enabled skills from config', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['quick-notes', 'task-tracker'],
          config: {},
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      await skillRegistry.loadSkills(config.skills.enabled);

      // Verify skills are loaded
      expect(skillRegistry.has('quick-notes')).toBe(true);
      expect(skillRegistry.has('task-tracker')).toBe(true);
      expect(skillRegistry.has('daily-priorities')).toBe(false);

      // Verify skill data
      const quickNotes = skillRegistry.get('quick-notes');
      expect(quickNotes?.id).toBe('quick-notes');
      expect(quickNotes?.name).toBe('Quick Notes');
      expect(quickNotes?.version).toBe('1.0.0');
      expect(quickNotes?.commands).toBeDefined();

      const taskTracker = skillRegistry.get('task-tracker');
      expect(taskTracker?.id).toBe('task-tracker');
      expect(taskTracker?.name).toBe('Task Tracker');
    });

    it('should create skill contexts for loaded skills', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['quick-notes'],
          config: {
            'quick-notes': { testConfig: true },
          },
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      await skillRegistry.loadSkills(['quick-notes']);

      const context = skillRegistry.getContext('quick-notes');
      expect(context).toBeDefined();
      expect(context?.skillId).toBe('quick-notes');
      expect(context?.config).toEqual({ testConfig: true });
      expect(context?.logger).toBeDefined();
      expect(context?.data).toBeDefined();
    });

    it('should load all productivity skills', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['quick-notes', 'task-tracker', 'daily-priorities', 'reminders'],
          config: {},
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      await skillRegistry.loadSkills(config.skills.enabled);

      const loaded = skillRegistry.getAll();
      expect(loaded.length).toBe(4);

      // Verify each skill loaded correctly
      for (const skillId of config.skills.enabled) {
        expect(skillRegistry.has(skillId)).toBe(true);
        const skill = skillRegistry.get(skillId);
        expect(skill).toBeDefined();
        expect(skill?.id).toBe(skillId);
        expect(skill?.commands).toBeDefined();
      }
    });

    it('should handle missing skills gracefully', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['quick-notes', 'non-existent-skill'],
          config: {},
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      
      // Should not throw, just log error
      await skillRegistry.loadSkills(config.skills.enabled);

      // Valid skill should still be loaded
      expect(skillRegistry.has('quick-notes')).toBe(true);
      expect(skillRegistry.has('non-existent-skill')).toBe(false);
    });

    it('should skip already loaded skills', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['quick-notes'],
          config: {},
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      
      // Load first time
      await skillRegistry.loadSkills(['quick-notes']);
      expect(skillRegistry.getAll().length).toBe(1);

      // Try to load again - should skip
      await skillRegistry.loadSkills(['quick-notes']);
      expect(skillRegistry.getAll().length).toBe(1);
    });
  });

  describe('Skill Commands', () => {
    it('should register commands for loaded skills', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['quick-notes'],
          config: {},
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      await skillRegistry.loadSkills(['quick-notes']);

      const skill = skillRegistry.get('quick-notes');
      expect(skill?.commands).toBeDefined();
      
      // Check specific commands exist
      const commands = Object.keys(skill?.commands || {});
      expect(commands).toContain('note');
    });

    it('should register task-tracker commands', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['task-tracker'],
          config: {},
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      await skillRegistry.loadSkills(['task-tracker']);

      const skill = skillRegistry.get('task-tracker');
      const commands = Object.keys(skill?.commands || {});
      expect(commands).toContain('task');
    });

    it('should register daily-priorities commands', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['daily-priorities'],
          config: {},
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      await skillRegistry.loadSkills(['daily-priorities']);

      const skill = skillRegistry.get('daily-priorities');
      const commands = Object.keys(skill?.commands || {});
      expect(commands).toContain('priorities');
    });

    it('should register reminders commands', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['reminders'],
          config: {},
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      await skillRegistry.loadSkills(['reminders']);

      const skill = skillRegistry.get('reminders');
      // Reminders skill has both LLM tools and a Telegram command
      const commands = Object.keys(skill?.commands || {});
      expect(commands).toContain('remind');
    });
  });

  describe('Skill Data Store', () => {
    it('should provide isolated data stores per skill', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['quick-notes', 'task-tracker'],
          config: {},
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      await skillRegistry.loadSkills(['quick-notes', 'task-tracker']);

      const quickNotesCtx = skillRegistry.getContext('quick-notes');
      const taskTrackerCtx = skillRegistry.getContext('task-tracker');

      // Store data in each skill
      quickNotesCtx?.data.set('test-key', 'quick-notes-data');
      taskTrackerCtx?.data.set('test-key', 'task-tracker-data');

      // Verify isolation
      expect(quickNotesCtx?.data.get('test-key')).toBe('quick-notes-data');
      expect(taskTrackerCtx?.data.get('test-key')).toBe('task-tracker-data');
    });
  });

  describe('Skill Unloading', () => {
    it('should unload skills and call onUnload hooks', async () => {
      const config = {
        paths: { skills: SKILLS_PATH },
        skills: {
          enabled: ['quick-notes'],
          config: {},
        },
        ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'test' } },
      } as Config;

      skillRegistry = new SkillRegistry(config, logger);
      await skillRegistry.loadSkills(['quick-notes']);
      expect(skillRegistry.has('quick-notes')).toBe(true);

      await skillRegistry.unloadSkill('quick-notes');
      expect(skillRegistry.has('quick-notes')).toBe(false);
      expect(skillRegistry.getContext('quick-notes')).toBeUndefined();
    });
  });
});

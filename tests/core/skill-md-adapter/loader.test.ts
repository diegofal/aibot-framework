/**
 * Tests for SkillMdLoader
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SkillMdLoader,
  DefaultToolGenerator,
  DefaultRegistryBridge,
  loadSkill,
  loadSkillsFromDirectory
} from '../../../src/core/skill-md-adapter/loader';
import { SkillMdParser } from '../../../src/core/skill-md-adapter/parser';
import { SkillValidator } from '../../../src/core/skill-md-adapter/validator';
import { SkillNotFoundError, SkillValidationError } from '../../../src/core/skill-md-adapter/types';

describe('SkillMdLoader', () => {
  let tempDir: string;
  let loader: SkillMdLoader;

  beforeEach(() => {
    tempDir = join(tmpdir(), `loader-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    loader = new SkillMdLoader(
      new SkillMdParser(),
      new SkillValidator(),
      new DefaultToolGenerator(),
      new DefaultRegistryBridge(),
      { validateOnLoad: true, checkRequirements: false }
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadFromDirectory', () => {
    it('should load a simple skill without tools', async () => {
      const skillDir = join(tempDir, 'simple-skill');
      mkdirSync(skillDir, { recursive: true });

      const content = `---
name: simple-skill
version: 1.0.0
description: A simple test skill
---

# Simple Skill

This is a simple skill with no tools.
`;
      writeFileSync(join(skillDir, 'SKILL.md'), content);

      const result = await loader.loadFromDirectory(skillDir);

      expect(result.name).toBe('simple-skill');
      expect(result.description).toBe('A simple test skill');
      expect(result.tools).toEqual([]);
      expect(result.status).toBe('loaded');
      expect(result.sourcePath).toBe(skillDir);
    });

    it('should load a skill with declared tools', async () => {
      const skillDir = join(tempDir, 'tool-skill');
      mkdirSync(skillDir, { recursive: true });
      mkdirSync(join(skillDir, 'scripts'), { recursive: true });

      const content = `---
name: tool-skill
version: 1.0.0
description: A skill with tools
---

# Tool Skill

Skill with tools.

### do-something

**Description:** Does something useful
**Parameters:**
- \`input\` (string, required): Input to process

**Implementation:** \`scripts/do-something.ts\`
`;
      writeFileSync(join(skillDir, 'SKILL.md'), content);
      writeFileSync(join(skillDir, 'scripts', 'do-something.ts'), 'export default async () => ({ success: true })');

      const result = await loader.loadFromDirectory(skillDir);

      expect(result.name).toBe('tool-skill');
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toBe('tool-skill.do-something');
    });

    it('should throw SkillNotFoundError when SKILL.md is missing', async () => {
      const skillDir = join(tempDir, 'no-skill');
      mkdirSync(skillDir, { recursive: true });

      expect(loader.loadFromDirectory(skillDir)).rejects.toThrow(SkillNotFoundError);
    });

    it('should throw SkillValidationError for invalid skill', async () => {
      const skillDir = join(tempDir, 'invalid-skill');
      mkdirSync(skillDir, { recursive: true });

      // Missing required fields
      const content = `---
name: invalid
version: not-semver
description: x
---

# Invalid
`;
      writeFileSync(join(skillDir, 'SKILL.md'), content);

      expect(loader.loadFromDirectory(skillDir)).rejects.toThrow(SkillValidationError);
    });

    it('should register skill in registry bridge', async () => {
      const skillDir = join(tempDir, 'register-test');
      mkdirSync(skillDir, { recursive: true });

      const content = `---
name: register-test
version: 1.0.0
description: Testing registration
---

# Register Test
`;
      writeFileSync(join(skillDir, 'SKILL.md'), content);

      await loader.loadFromDirectory(skillDir);

      expect(loader.isSkillRegistered('register-test')).toBe(true);
    });

    it('should unregister a skill', async () => {
      const skillDir = join(tempDir, 'unregister-test');
      mkdirSync(skillDir, { recursive: true });

      const content = `---
name: unregister-test
version: 1.0.0
description: Testing unregistration
---

# Unregister Test
`;
      writeFileSync(join(skillDir, 'SKILL.md'), content);

      await loader.loadFromDirectory(skillDir);
      expect(loader.isSkillRegistered('unregister-test')).toBe(true);

      loader.unregister('unregister-test');
      expect(loader.isSkillRegistered('unregister-test')).toBe(false);
    });

    it('should handle skills with metadata', async () => {
      const skillDir = join(tempDir, 'meta-skill');
      mkdirSync(skillDir, { recursive: true });

      const content = `---
name: meta-skill
version: 2.0.0
description: A skill with metadata
metadata:
  aibot:
    emoji: "🎯"
    category: web
    disabledByDefault: false
    maxRetries: 3
---

# Meta Skill

Skill with metadata.
`;
      writeFileSync(join(skillDir, 'SKILL.md'), content);

      const result = await loader.loadFromDirectory(skillDir);

      expect(result.name).toBe('meta-skill');
      expect(result.status).toBe('loaded');
    });
  });

  describe('loadFromParentDirectory', () => {
    it('should load multiple skills from parent directory', async () => {
      const parentDir = join(tempDir, 'skills');

      // Create skill 1
      const skill1Dir = join(parentDir, 'skill-one');
      mkdirSync(skill1Dir, { recursive: true });
      writeFileSync(join(skill1Dir, 'SKILL.md'), `---
name: skill-one
version: 1.0.0
description: First skill
---

# Skill One
`);

      // Create skill 2
      const skill2Dir = join(parentDir, 'skill-two');
      mkdirSync(skill2Dir, { recursive: true });
      writeFileSync(join(skill2Dir, 'SKILL.md'), `---
name: skill-two
version: 1.0.0
description: Second skill
---

# Skill Two
`);

      // Create non-skill directory
      const notSkillDir = join(parentDir, 'not-a-skill');
      mkdirSync(notSkillDir, { recursive: true });
      writeFileSync(join(notSkillDir, 'README.md'), '# Not a skill');

      const results = await loader.loadFromParentDirectory(parentDir);

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('loaded');
      expect(results[1].status).toBe('loaded');
    });

    it('should continue loading other skills when one fails', async () => {
      const parentDir = join(tempDir, 'mixed-skills');

      // Create valid skill
      const validDir = join(parentDir, 'valid-skill');
      mkdirSync(validDir, { recursive: true });
      writeFileSync(join(validDir, 'SKILL.md'), `---
name: valid-skill
version: 1.0.0
description: Valid skill
---

# Valid
`);

      // Create invalid skill
      const invalidDir = join(parentDir, 'invalid-skill');
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(join(invalidDir, 'SKILL.md'), `---
name: bad
version: not-semver
description: x
---

# Bad
`);

      const results = await loader.loadFromParentDirectory(parentDir);

      expect(results).toHaveLength(2);

      const valid = results.find(r => r.name === 'valid-skill');
      const invalid = results.find(r => r.name === 'invalid-skill');

      expect(valid?.status).toBe('loaded');
      expect(invalid?.status).toBe('error');
    });
  });

  describe('convenience functions', () => {
    it('loadSkill should work with defaults', async () => {
      const skillDir = join(tempDir, 'convenience');
      mkdirSync(skillDir, { recursive: true });

      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: convenience-skill
version: 1.0.0
description: Convenience test
---

# Convenience
`);

      const result = await loadSkill(skillDir, { checkRequirements: false });

      expect(result.name).toBe('convenience-skill');
      expect(result.status).toBe('loaded');
    });

    it('loadSkillsFromDirectory should work with defaults', async () => {
      const parentDir = join(tempDir, 'convenience-parent');

      const skillDir = join(parentDir, 'my-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: my-skill
version: 1.0.0
description: My skill
---

# My Skill
`);

      const results = await loadSkillsFromDirectory(parentDir, { checkRequirements: false });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('my-skill');
    });
  });

  describe('DefaultToolGenerator', () => {
    it('should generate tool with correct function definition', async () => {
      const generator = new DefaultToolGenerator();

      const declared = {
        name: 'test-tool',
        description: 'A test tool',
        parameters: [
          { name: 'arg1', type: 'string' as const, description: 'First arg', required: true },
          { name: 'arg2', type: 'number' as const, description: 'Second arg', required: false, default: 42 },
        ],
        implementation: 'scripts/test.ts',
      };

      const tool = await generator.generate(declared, tempDir, 'my-skill');

      expect(tool.definition.type).toBe('function');
      expect(tool.definition.function.name).toBe('my-skill.test-tool');
      expect(tool.definition.function.description).toBe('A test tool');
      expect(tool.definition.function.parameters.type).toBe('object');
      expect(tool.definition.function.parameters.properties).toHaveProperty('arg1');
      expect(tool.definition.function.parameters.properties).toHaveProperty('arg2');
      expect(tool.definition.function.parameters.required).toEqual(['arg1']);
    });

    it('should handle tool without implementation', async () => {
      const generator = new DefaultToolGenerator();

      const declared = {
        name: 'instruction-only',
        description: 'Just instructions',
        parameters: [],
      };

      const tool = await generator.generate(declared, tempDir, 'my-skill');

      expect(tool.definition.function.name).toBe('my-skill.instruction-only');

      // Execute should return placeholder
      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.result).toContain('no implementation defined');
    });
  });

  describe('DefaultRegistryBridge', () => {
    it('should register and retrieve skills', async () => {
      const bridge = new DefaultRegistryBridge();

      const skill = {
        name: 'test-skill',
        description: 'Test',
        instructions: 'Test instructions',
        tools: [],
        sourcePath: tempDir,
      };

      await bridge.register(skill);

      expect(bridge.isSkillRegistered('test-skill')).toBe(true);
      expect(bridge.getRegisteredSkill('test-skill')?.name).toBe('test-skill');
    });

    it('should return all registered skills', async () => {
      const bridge = new DefaultRegistryBridge();

      await bridge.register({
        name: 'skill-1',
        description: 'First',
        instructions: 'First instructions',
        tools: [],
        sourcePath: tempDir,
      });

      await bridge.register({
        name: 'skill-2',
        description: 'Second',
        instructions: 'Second instructions',
        tools: [],
        sourcePath: tempDir,
      });

      const all = bridge.getAllRegisteredSkills();
      expect(all).toHaveLength(2);
    });

    it('should unregister skills', async () => {
      const bridge = new DefaultRegistryBridge();

      await bridge.register({
        name: 'to-remove',
        description: 'To be removed',
        instructions: 'Instructions',
        tools: [],
        sourcePath: tempDir,
      });

      expect(bridge.isSkillRegistered('to-remove')).toBe(true);

      bridge.unregister('to-remove');

      expect(bridge.isSkillRegistered('to-remove')).toBe(false);
    });
  });
});

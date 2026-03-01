/**
 * Tests for SkillValidator
 */

import { describe, expect, it } from 'bun:test';
import type { DeclaredTool, SkillDocument } from '../../../src/core/skill-md-adapter/types';
import { SkillValidator } from '../../../src/core/skill-md-adapter/validator';

describe('SkillValidator', () => {
  const validator = new SkillValidator();

  describe('validateManifest', () => {
    it('should validate valid manifest', () => {
      const doc: Partial<SkillDocument> = {
        name: 'valid-skill',
        version: '1.0.0',
        description: 'A valid test skill description',
      };

      const result = validator.validateManifest(doc);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid skill name', () => {
      const doc: Partial<SkillDocument> = {
        name: 'Invalid_Skill_Name',
        version: '1.0.0',
        description: 'Description here',
      };

      const result = validator.validateManifest(doc);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('name');
    });

    it('should reject invalid version', () => {
      const doc: Partial<SkillDocument> = {
        name: 'valid-skill',
        version: 'not-semver',
        description: 'Description here',
      };

      const result = validator.validateManifest(doc);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('version');
    });

    it('should reject short description', () => {
      const doc: Partial<SkillDocument> = {
        name: 'valid-skill',
        version: '1.0.0',
        description: 'Short',
      };

      const result = validator.validateManifest(doc);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('description');
    });
  });

  describe('validateTool', () => {
    it('should validate valid tool', () => {
      const tool: DeclaredTool = {
        name: 'valid-tool',
        description: 'A valid tool description that is long enough',
        parameters: [],
      };

      const result = validator.validateTool(tool);

      expect(result.valid).toBe(true);
    });

    it('should reject tool with short description', () => {
      const tool: DeclaredTool = {
        name: 'valid-tool',
        description: 'Short',
        parameters: [],
      };

      const result = validator.validateTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('description');
    });

    it('should reject tool with invalid name', () => {
      const tool: DeclaredTool = {
        name: 'InvalidTool',
        description: 'A valid tool description that is long enough',
        parameters: [],
      };

      const result = validator.validateTool(tool);

      expect(result.valid).toBe(false);
    });

    it('should validate tool with parameters', () => {
      const tool: DeclaredTool = {
        name: 'param-tool',
        description: 'A valid tool description that is long enough',
        parameters: [
          {
            name: 'validParam',
            type: 'string',
            description: 'A parameter',
            required: true,
          },
        ],
      };

      const result = validator.validateTool(tool);

      expect(result.valid).toBe(true);
    });

    it('should reject tool with invalid parameter name', () => {
      const tool: DeclaredTool = {
        name: 'valid-tool',
        description: 'A valid tool description that is long enough',
        parameters: [
          {
            name: 'Invalid-Param',
            type: 'string',
            description: 'A parameter',
            required: true,
          },
        ],
      };

      const result = validator.validateTool(tool);

      expect(result.valid).toBe(false);
    });
  });

  describe('validate', () => {
    it('should validate complete document', () => {
      const doc: SkillDocument = {
        name: 'test-skill',
        version: '1.0.0',
        description: 'A test skill with sufficient description',
        instructions: '# Instructions\n\nSome content here.',
        declaredTools: [],
        sourcePath: '/test/SKILL.md',
      };

      const result = validator.validate(doc);

      expect(result.valid).toBe(true);
    });

    it('should reject document with empty instructions', () => {
      const doc: SkillDocument = {
        name: 'test-skill',
        version: '1.0.0',
        description: 'A test skill with sufficient description',
        instructions: '   ',
        declaredTools: [],
        sourcePath: '/test/SKILL.md',
      };

      const result = validator.validate(doc);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('empty');
    });

    it('should validate with tools', () => {
      const doc: SkillDocument = {
        name: 'test-skill',
        version: '1.0.0',
        description: 'A test skill with sufficient description',
        instructions: '# Instructions',
        declaredTools: [
          {
            name: 'test-tool',
            description: 'A valid tool description',
            parameters: [],
            implementation: 'scripts/tool.ts',
          },
        ],
        sourcePath: '/test/SKILL.md',
      };

      const result = validator.validate(doc);

      expect(result.valid).toBe(true);
    });

    it('should reject invalid implementation path', () => {
      const doc: SkillDocument = {
        name: 'test-skill',
        version: '1.0.0',
        description: 'A test skill with sufficient description',
        instructions: '# Instructions',
        declaredTools: [
          {
            name: 'test-tool',
            description: 'A valid tool description',
            parameters: [],
            implementation: '../escape.ts',
          },
        ],
        sourcePath: '/test/SKILL.md',
      };

      const result = validator.validate(doc);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid implementation path');
    });
  });
});

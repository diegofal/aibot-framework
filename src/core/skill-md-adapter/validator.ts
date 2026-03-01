/**
 * Skill Validator
 * Validates parsed SkillDocument against Zod schemas
 */

import { z } from 'zod';
import {
  DeclaredToolSchema,
  SkillDocumentSchema,
  SkillManifestSchema,
  ToolParameterSchema,
} from './schema';
import type { SkillDocument, ValidationResult } from './types';
import { SkillValidationError } from './types';

export class SkillValidator {
  /**
   * Validate a complete SkillDocument
   */
  validate(doc: SkillDocument): ValidationResult {
    const errors: string[] = [];

    // Validate manifest (YAML frontmatter)
    const manifestResult = this.validateManifest(doc);
    if (!manifestResult.valid) {
      errors.push(...manifestResult.errors);
    }

    // Validate tools
    for (const tool of doc.declaredTools) {
      const toolResult = this.validateTool(tool);
      if (!toolResult.valid) {
        errors.push(`Tool "${tool.name}": ${toolResult.errors.join(', ')}`);
      }
    }

    // Validate instructions exist
    if (!doc.instructions || doc.instructions.trim().length === 0) {
      errors.push('Instructions cannot be empty');
    }

    // Validate tool implementations exist if specified
    for (const tool of doc.declaredTools) {
      if (tool.implementation && !this.isValidImplementationPath(tool.implementation)) {
        errors.push(`Tool "${tool.name}": Invalid implementation path "${tool.implementation}"`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate manifest portion
   */
  validateManifest(doc: Partial<SkillDocument>): ValidationResult {
    const result = SkillManifestSchema.safeParse({
      name: doc.name,
      version: doc.version,
      description: doc.description,
      metadata: doc.metadata,
    });

    if (result.success) {
      return { valid: true, errors: [] };
    }

    return {
      valid: false,
      errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
    };
  }

  /**
   * Validate a single tool declaration
   */
  validateTool(tool: unknown): ValidationResult {
    const result = DeclaredToolSchema.safeParse(tool);

    if (result.success) {
      return { valid: true, errors: [] };
    }

    return {
      valid: false,
      errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
    };
  }

  /**
   * Validate a single parameter
   */
  validateParameter(param: unknown): ValidationResult {
    const result = ToolParameterSchema.safeParse(param);

    if (result.success) {
      return { valid: true, errors: [] };
    }

    return {
      valid: false,
      errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
    };
  }

  /**
   * Check if implementation path is valid
   */
  private isValidImplementationPath(path: string): boolean {
    // Must be relative path
    if (path.startsWith('/')) return false;

    // Must not contain path traversal
    if (path.includes('..')) return false;

    // Must be .ts or .js file
    if (!path.endsWith('.ts') && !path.endsWith('.js')) {
      return false;
    }

    return true;
  }

  /**
   * Validate and throw on error
   */
  validateOrThrow(doc: SkillDocument): void {
    const result = this.validate(doc);
    if (!result.valid) {
      throw new SkillValidationError(result.errors);
    }
  }
}

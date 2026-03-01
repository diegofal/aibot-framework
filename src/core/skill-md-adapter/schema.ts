/**
 * Zod schemas for SKILL.md validation
 * Mirrors the TypeScript types with runtime validation
 */

import { z } from 'zod';

// ============================================================================
// Parameter Schema
// ============================================================================

export const ToolParameterSchema = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/, 'Parameter name must start with lowercase letter'),
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  description: z.string().min(1, 'Description is required'),
  required: z.boolean().default(true),
  default: z.unknown().optional(),
});

// ============================================================================
// Tool Declaration Schema
// ============================================================================

export const DeclaredToolSchema = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9_-]+$/, 'Tool name must be kebab-case or snake_case'),
  description: z
    .string()
    .min(10, 'Description must be at least 10 characters')
    .max(500, 'Description must be at most 500 characters'),
  parameters: z.array(ToolParameterSchema).default([]),
  implementation: z.string().optional(),
});

// ============================================================================
// Manifest Schema (YAML frontmatter)
// ============================================================================

export const SkillRequirementsSchema = z.object({
  anyBins: z.array(z.string()).optional(),
  allBins: z.array(z.string()).optional(),
});

export const AibotMetadataSchema = z.object({
  emoji: z.string().emoji().optional(),
  category: z
    .enum([
      'web',
      'memory',
      'soul',
      'files',
      'system',
      'social',
      'calendar',
      'communication',
      'browser',
      'production',
    ])
    .default('production'),
  requires: SkillRequirementsSchema.optional(),
  permissions: z.array(z.string()).optional(),
  disabledByDefault: z.boolean().default(false),
  maxRetries: z.number().int().min(0).max(5).optional(),
});

export const SkillMetadataSchema = z.object({
  aibot: AibotMetadataSchema.optional(),
});

export const SkillManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'Skill name must be lowercase with hyphens'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'Version must be semver (e.g., 1.0.0)')
    .default('1.0.0'),
  description: z
    .string()
    .min(10, 'Description must be at least 10 characters')
    .max(500, 'Description must be at most 500 characters'),
  metadata: SkillMetadataSchema.optional(),
});

// ============================================================================
// Full Document Schema (manifest + parsed content)
// ============================================================================

export const SkillDocumentSchema = SkillManifestSchema.extend({
  instructions: z.string().min(1, 'Instructions cannot be empty'),
  declaredTools: z.array(DeclaredToolSchema).default([]),
  sourcePath: z.string(),
});

// ============================================================================
// Type exports (inferred from schemas)
// ============================================================================

export type ToolParameterSchema = z.infer<typeof ToolParameterSchema>;
export type DeclaredToolSchema = z.infer<typeof DeclaredToolSchema>;
export type SkillManifestSchema = z.infer<typeof SkillManifestSchema>;
export type SkillDocumentSchema = z.infer<typeof SkillDocumentSchema>;

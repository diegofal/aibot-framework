/**
 * Type definitions for SKILL.md adapter
 * Transplanted from OpenClaw pattern, adapted for aibot-framework
 */

import type { ToolDefinition } from '../../tools/types';

// ============================================================================
// Parameter Types
// ============================================================================

export type ToolParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface ToolParameter {
  name: string;
  type: ToolParameterType;
  description: string;
  required: boolean;
  default?: unknown;
}

// ============================================================================
// Tool Declaration (from SKILL.md)
// ============================================================================

export interface DeclaredTool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  implementation?: string; // Path relative to scripts/
}

// ============================================================================
// Skill Manifest (YAML frontmatter)
// ============================================================================

export interface SkillRequirements {
  anyBins?: string[];  // At least one must exist
  allBins?: string[];  // All must exist
}

export type SkillCategory =
  | 'web'
  | 'memory'
  | 'soul'
  | 'files'
  | 'system'
  | 'social'
  | 'calendar'
  | 'communication'
  | 'browser'
  | 'production';

export interface AibotMetadata {
  emoji?: string;
  category?: SkillCategory;
  requires?: SkillRequirements;
  permissions?: string[];
  disabledByDefault?: boolean;
  maxRetries?: number;
}

export interface SkillMetadata {
  aibot?: AibotMetadata;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  metadata?: SkillMetadata;
}

// ============================================================================
// Parsed Skill Document
// ============================================================================

export interface SkillDocument extends SkillManifest {
  instructions: string;        // Markdown body
  declaredTools: DeclaredTool[];
  sourcePath: string;        // Absolute path to SKILL.md
}

// ============================================================================
// Loaded Skill (after registration)
// ============================================================================

export interface Tool {
  definition: ToolDefinition;
  execute: ToolExecuteFunction;
}

export interface ToolResult {
  success: boolean;
  result: string | object;
  error?: string;
}

export type ToolExecuteFunction = (
  args: Record<string, unknown>,
  logger?: Logger
) => Promise<ToolResult>;

export interface Logger {
  debug: (message: string, meta?: object) => void;
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
}

export interface LoadedSkill {
  name: string;
  description: string;
  tools: string[];        // Tool IDs (prefixed)
  status: 'loaded' | 'error';
  sourcePath: string;
  error?: string;
}

// ============================================================================
// Declarative Skill (for HandlerRegistrar integration)
// ============================================================================

export interface DeclarativeSkill {
  name: string;
  description: string;
  instructions: string;
  tools: Tool[];
  metadata?: AibotMetadata;
  sourcePath: string;
}

// ============================================================================
// Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================================================
// Parser Errors
// ============================================================================

export class SkillParseError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly line?: number
  ) {
    super(`Failed to parse ${filePath}${line ? `:${line}` : ''}: ${message}`);
    this.name = 'SkillParseError';
  }
}

export class SkillNotFoundError extends Error {
  constructor(public readonly skillDir: string) {
    super(`SKILL.md not found in ${skillDir}`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Skill validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    this.name = 'SkillValidationError';
  }
}

export class SkillRequirementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillRequirementError';
  }
}

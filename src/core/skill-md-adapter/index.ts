/**
 * SKILL.md Adapter for aibot-framework
 *
 * Transplants OpenClaw's declarative skill pattern into aibot-framework.
 * Allows defining skills via Markdown + YAML instead of TypeScript code.
 *
 * @example
 * ```typescript
 * import { SkillMdParser, SkillValidator, SkillMdLoader } from './skill-md-adapter';
 *
 * const parser = new SkillMdParser();
 * const validator = new SkillValidator();
 * const loader = new SkillMdLoader(parser, validator, ...);
 *
 * const skill = await loader.loadFromDirectory('./skills/my-skill');
 * ```
 */

// Core classes
export { SkillMdParser } from './parser';
export { SkillValidator } from './validator';
export {
  SkillMdLoader,
  DefaultToolGenerator,
  DefaultRegistryBridge,
  loadSkill,
  loadSkillsFromDirectory,
} from './loader';
export type {
  LoaderConfig,
  ToolGenerator,
  RegistryBridge,
} from './loader';

// Framework integration
export {
  hasSkillMd,
  loadDeclarativeSkill,
  discoverSkillDirsExtended,
  loadExternalSkillUnified,
} from './framework-bridge';

// Types
export type {
  // Core types
  SkillDocument,
  SkillManifest,
  DeclaredTool,
  ToolParameter,
  ToolParameterType,
  // Metadata types
  SkillMetadata,
  AibotMetadata,
  SkillRequirements,
  SkillCategory,
  // Runtime types
  LoadedSkill,
  DeclarativeSkill,
  Tool,
  ToolResult,
  ToolExecuteFunction,
  Logger,
  ValidationResult,
} from './types';

// Error types
export {
  SkillParseError,
  SkillNotFoundError,
  SkillValidationError,
  SkillRequirementError,
} from './types';

// Schemas (for advanced use)
export {
  ToolParameterSchema,
  DeclaredToolSchema,
  SkillManifestSchema,
  SkillDocumentSchema,
  SkillRequirementsSchema,
  AibotMetadataSchema,
} from './schema';

// Version
export const VERSION = '1.0.0';

/**
 * SkillMdLoader
 * Loads declarative skills from SKILL.md files into aibot-framework
 *
 * Flow: Parse → Validate → Check Requirements → Generate Tools → Register
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  SkillDocument,
  LoadedSkill,
  DeclarativeSkill,
  Tool,
  ToolResult,
  Logger,
  DeclaredTool
} from './types';
import { SkillMdParser } from './parser';
import { SkillValidator } from './validator';
import { SkillNotFoundError, SkillValidationError, SkillRequirementError } from './types';

const execAsync = promisify(exec);

export interface LoaderConfig {
  /** Base directory for resolving relative paths */
  basePath?: string;
  /** Default logger if none provided */
  defaultLogger?: Logger;
  /** Whether to validate on load (default: true) */
  validateOnLoad?: boolean;
  /** Whether to check binary requirements (default: true) */
  checkRequirements?: boolean;
}

export interface ToolGenerator {
  generate(
    declared: DeclaredTool,
    skillDir: string,
    skillName: string,
    logger?: Logger
  ): Promise<Tool>;
}

export interface RegistryBridge {
  register(skill: DeclarativeSkill): Promise<void>;
  isSkillRegistered(name: string): boolean;
  unregister(name: string): void;
}

/**
 * Default tool generator that creates tools from declared implementations
 */
export class DefaultToolGenerator implements ToolGenerator {
  async generate(
    declared: DeclaredTool,
    skillDir: string,
    skillName: string,
    logger?: Logger
  ): Promise<Tool> {
    const toolId = `${skillName}.${declared.name}`;

    // Build OpenAI function definition
    const functionDef = this.buildFunctionDefinition(toolId, declared);

    // Create execute function
    const execute = this.createExecuteFunction(declared, skillDir, skillName, logger);

    return {
      definition: functionDef,
      execute,
    };
  }

  private buildFunctionDefinition(toolId: string, declared: DeclaredTool) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const param of declared.parameters) {
      properties[param.name] = {
        type: param.type,
        description: param.description,
        ...(param.default !== undefined && { default: param.default }),
      };
      if (param.required) {
        required.push(param.name);
      }
    }

    return {
      type: 'function' as const,
      function: {
        name: toolId,
        description: declared.description,
        parameters: {
          type: 'object' as const,
          properties,
          required,
        },
      },
    };
  }

  private createExecuteFunction(
    declared: DeclaredTool,
    skillDir: string,
    skillName: string,
    logger?: Logger
  ) {
    return async (args: Record<string, unknown>, callLogger?: Logger): Promise<ToolResult> => {
      const log = callLogger || logger || this.createDefaultLogger();

      if (!declared.implementation) {
        // No implementation: treat as instruction-only tool
        log.debug(`Tool ${declared.name} executed (no implementation defined)`);
        return {
          success: true,
          result: `Tool ${declared.name} executed (no implementation defined)`,
        };
      }

      try {
        // Resolve implementation path
        const fullPath = join(skillDir, declared.implementation);

        if (!existsSync(fullPath)) {
          return {
            success: false,
            result: '',
            error: `Implementation file not found: ${declared.implementation}`,
          };
        }

        // Dynamic import of the implementation
        // Note: In production, this might need to be handled differently
        // depending on the module system and build process
        log.debug(`Loading implementation from ${fullPath}`);

        // For now, return a placeholder result
        // The actual implementation loading would depend on the framework's module system
        return {
          success: true,
          result: `Tool ${declared.name} from skill ${skillName} would execute with args: ${JSON.stringify(args)}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Tool execution failed: ${message}`);
        return {
          success: false,
          result: '',
          error: message,
        };
      }
    };
  }

  private createDefaultLogger(): Logger {
    return {
      debug: () => {},
      info: () => {},
      warn: console.warn,
      error: console.error,
    };
  }
}

/**
 * Default registry bridge for integration with aibot-framework
 * This is a placeholder that would be replaced with actual framework integration
 */
export class DefaultRegistryBridge implements RegistryBridge {
  private registeredSkills = new Map<string, DeclarativeSkill>();

  async register(skill: DeclarativeSkill): Promise<void> {
    this.registeredSkills.set(skill.name, skill);
  }

  isSkillRegistered(name: string): boolean {
    return this.registeredSkills.has(name);
  }

  unregister(name: string): void {
    this.registeredSkills.delete(name);
  }

  getRegisteredSkill(name: string): DeclarativeSkill | undefined {
    return this.registeredSkills.get(name);
  }

  getAllRegisteredSkills(): DeclarativeSkill[] {
    return Array.from(this.registeredSkills.values());
  }
}

/**
 * Main loader class for SKILL.md files
 */
export class SkillMdLoader {
  private parser: SkillMdParser;
  private validator: SkillValidator;
  private toolGenerator: ToolGenerator;
  private registryBridge: RegistryBridge;
  private config: Required<LoaderConfig>;

  constructor(
    parser: SkillMdParser = new SkillMdParser(),
    validator: SkillValidator = new SkillValidator(),
    toolGenerator: ToolGenerator = new DefaultToolGenerator(),
    registryBridge: RegistryBridge = new DefaultRegistryBridge(),
    config: LoaderConfig = {}
  ) {
    this.parser = parser;
    this.validator = validator;
    this.toolGenerator = toolGenerator;
    this.registryBridge = registryBridge;
    this.config = {
      basePath: config.basePath || process.cwd(),
      defaultLogger: config.defaultLogger || this.createDefaultLogger(),
      validateOnLoad: config.validateOnLoad ?? true,
      checkRequirements: config.checkRequirements ?? true,
    };
  }

  /**
   * Load a skill from a directory containing SKILL.md
   */
  async loadFromDirectory(skillDir: string): Promise<LoadedSkill> {
    const skillMdPath = join(skillDir, 'SKILL.md');

    if (!existsSync(skillMdPath)) {
      throw new SkillNotFoundError(skillDir);
    }

    try {
      // Step 1: Parse
      const doc = this.parser.parse(skillMdPath);

      // Step 2: Validate (if enabled)
      if (this.config.validateOnLoad) {
        const validation = this.validator.validate(doc);
        if (!validation.valid) {
          throw new SkillValidationError(validation.errors);
        }
      }

      // Step 3: Check binary requirements (if enabled)
      if (this.config.checkRequirements) {
        await this.checkRequirements(doc);
      }

      // Step 4: Generate tools
      const tools: Tool[] = [];
      for (const declared of doc.declaredTools) {
        const tool = await this.toolGenerator.generate(
          declared,
          skillDir,
          doc.name,
          this.config.defaultLogger
        );
        tools.push(tool);
      }

      // Step 5: Register with framework
      const declarativeSkill: DeclarativeSkill = {
        name: doc.name,
        description: doc.description,
        instructions: doc.instructions,
        tools,
        metadata: doc.metadata?.aibot,
        sourcePath: skillDir,
      };

      await this.registryBridge.register(declarativeSkill);

      return {
        name: doc.name,
        description: doc.description,
        tools: tools.map(t => t.definition.function.name),
        status: 'loaded',
        sourcePath: skillDir,
      };
    } catch (error) {
      // Re-throw known errors
      if (error instanceof SkillNotFoundError ||
          error instanceof SkillValidationError ||
          error instanceof SkillRequirementError) {
        throw error;
      }

      // Wrap unknown errors
      throw new Error(
        `Failed to load skill from ${skillDir}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Load multiple skills from a parent directory
   */
  async loadFromParentDirectory(parentDir: string): Promise<LoadedSkill[]> {
    const { readdir } = await import('fs/promises');
    const results: LoadedSkill[] = [];

    try {
      const entries = await readdir(parentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillDir = join(parentDir, entry.name);
          const skillMdPath = join(skillDir, 'SKILL.md');

          if (existsSync(skillMdPath)) {
            try {
              const skill = await this.loadFromDirectory(skillDir);
              results.push(skill);
            } catch (error) {
              results.push({
                name: entry.name,
                description: 'Failed to load',
                tools: [],
                status: 'error',
                sourcePath: skillDir,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to read parent directory ${parentDir}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return results;
  }

  /**
   * Check if a skill is already registered
   */
  isSkillRegistered(name: string): boolean {
    return this.registryBridge.isSkillRegistered(name);
  }

  /**
   * Unregister a skill
   */
  unregister(name: string): void {
    this.registryBridge.unregister(name);
  }

  /**
   * Check binary requirements for a skill
   */
  private async checkRequirements(doc: SkillDocument): Promise<void> {
    const requires = doc.metadata?.aibot?.requires;
    if (!requires) return;

    // Check anyBins: at least one must exist
    if (requires.anyBins && requires.anyBins.length > 0) {
      const hasAny = await this.checkAnyBinExists(requires.anyBins);
      if (!hasAny) {
        throw new SkillRequirementError(
          `Skill "${doc.name}" requires at least one of: ${requires.anyBins.join(', ')}`
        );
      }
    }

    // Check allBins: all must exist
    if (requires.allBins && requires.allBins.length > 0) {
      const missing = await this.checkMissingBins(requires.allBins);
      if (missing.length > 0) {
        throw new SkillRequirementError(
          `Skill "${doc.name}" requires binaries: ${missing.join(', ')}`
        );
      }
    }
  }

  private async checkAnyBinExists(bins: string[]): Promise<boolean> {
    for (const bin of bins) {
      if (await this.binExists(bin)) return true;
    }
    return false;
  }

  private async checkMissingBins(bins: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const bin of bins) {
      if (!(await this.binExists(bin))) {
        missing.push(bin);
      }
    }
    return missing;
  }

  private async binExists(bin: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`which ${bin}`);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private createDefaultLogger(): Logger {
    return {
      debug: () => {},
      info: () => {},
      warn: console.warn,
      error: console.error,
    };
  }
}

// Export convenience function for simple use cases
export async function loadSkill(
  skillDir: string,
  config?: LoaderConfig
): Promise<LoadedSkill> {
  const loader = new SkillMdLoader(
    undefined, // use default parser
    undefined, // use default validator
    undefined, // use default tool generator
    undefined, // use default registry bridge
    config
  );
  return loader.loadFromDirectory(skillDir);
}

export async function loadSkillsFromDirectory(
  parentDir: string,
  config?: LoaderConfig
): Promise<LoadedSkill[]> {
  const loader = new SkillMdLoader(
    undefined,
    undefined,
    undefined,
    undefined,
    config
  );
  return loader.loadFromParentDirectory(parentDir);
}

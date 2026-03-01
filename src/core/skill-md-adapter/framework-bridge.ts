/**
 * Framework Bridge - Integrates SkillMdLoader with aibot-framework
 *
 * Converts SkillMdLoader output to the format expected by external-skill-loader.ts
 * and provides handler wrappers for declarative tools.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '../../logger';
import type {
  ExternalSkillManifest,
  ExternalToolDef,
  LoadedExternalSkill,
} from '../external-skill-loader';
import { DefaultRegistryBridge, DefaultToolGenerator, SkillMdLoader } from './loader';
import { SkillMdParser } from './parser';
import type { DeclarativeSkill, Tool } from './types';
import { SkillValidator } from './validator';

/**
 * Check if a directory contains a SKILL.md file
 */
export function hasSkillMd(skillDir: string): boolean {
  return existsSync(join(skillDir, 'SKILL.md'));
}

/**
 * Convert a declarative skill to the external skill manifest format
 */
function convertToManifest(skill: DeclarativeSkill): ExternalSkillManifest {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description,
    tools: skill.tools.map((tool) => convertToolToExternalDef(tool)),
    config: skill.metadata || {},
  };
}

/**
 * Convert a SkillMdAdapter Tool to ExternalToolDef format
 */
function convertToolToExternalDef(tool: Tool): ExternalToolDef {
  const fn = tool.definition.function;
  return {
    name: fn.name,
    description: fn.description,
    parameters: {
      type: 'object',
      properties: fn.parameters.properties as Record<string, unknown>,
      required: fn.parameters.required || [],
    },
  };
}

/**
 * Create handler functions from declarative skill tools
 */
function createHandlers(skill: DeclarativeSkill): Record<string, Function> {
  const handlers: Record<string, Function> = {};

  for (const tool of skill.tools) {
    handlers[tool.definition.function.name] = async (
      args: Record<string, unknown>,
      context: unknown
    ) => {
      const result = await tool.execute(args, (context as { logger?: Logger })?.logger);
      return result;
    };
  }

  return handlers;
}

/**
 * Load a declarative skill from a directory containing SKILL.md
 * Returns in the format expected by external-skill-loader.ts
 */
export async function loadDeclarativeSkill(
  skillDir: string,
  logger: Logger
): Promise<LoadedExternalSkill> {
  const skillMdPath = join(skillDir, 'SKILL.md');

  if (!existsSync(skillMdPath)) {
    throw new Error(`SKILL.md not found in ${skillDir}`);
  }

  // Initialize SkillMdLoader with default components
  // Note: checkRequirements is disabled here because we handle it manually
  // to convert missing binaries to warnings instead of errors
  const loader = new SkillMdLoader(
    new SkillMdParser(),
    new SkillValidator(),
    new DefaultToolGenerator(),
    new DefaultRegistryBridge(),
    {
      basePath: skillDir,
      defaultLogger: logger,
      validateOnLoad: true,
      checkRequirements: false, // We handle this manually to produce warnings
    }
  );

  // Load the skill
  const loaded = await loader.loadFromDirectory(skillDir);

  // Get the registered skill from the bridge
  const bridge = (
    loader as unknown as {
      registryBridge: DefaultRegistryBridge;
    }
  ).registryBridge;

  const declarativeSkill = bridge.getRegisteredSkill(loaded.name);

  if (!declarativeSkill) {
    throw new Error(`Failed to retrieve loaded skill: ${loaded.name}`);
  }

  // Convert to external skill format
  const manifest = convertToManifest(declarativeSkill);
  const handlers = createHandlers(declarativeSkill);

  // Collect warnings from binary checks
  const warnings: string[] = [];
  const requires = declarativeSkill.metadata?.requires;

  if (requires?.anyBins) {
    for (const bin of requires.anyBins) {
      if (!Bun.which(bin)) {
        warnings.push(`Missing binary (anyBins): ${bin}`);
      }
    }
  }

  if (requires?.allBins) {
    for (const bin of requires.allBins) {
      if (!Bun.which(bin)) {
        warnings.push(`Missing binary (allBins): ${bin}`);
      }
    }
  }

  return {
    manifest,
    handlers,
    dir: skillDir,
    warnings,
  };
}

/**
 * Extended skill discovery that finds both skill.json and SKILL.md
 */
export function discoverSkillDirsExtended(paths: string[]): Array<{
  dir: string;
  type: 'json' | 'skillmd';
}> {
  const results: Array<{ dir: string; type: 'json' | 'skillmd' }> = [];

  for (const basePath of paths) {
    const absPath = resolve(basePath);
    if (!existsSync(absPath)) continue;

    let entries: string[];
    try {
      const { readdirSync } = require('node:fs');
      entries = readdirSync(absPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(absPath, entry);
      try {
        const { statSync } = require('node:fs');
        if (!statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }

      // Check for SKILL.md first (new format)
      if (existsSync(join(skillDir, 'SKILL.md'))) {
        results.push({ dir: skillDir, type: 'skillmd' });
        continue;
      }

      // Fallback to skill.json (existing format)
      const manifestPath = join(skillDir, 'skill.json');
      if (existsSync(manifestPath)) {
        try {
          const { readFileSync } = require('node:fs');
          const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
          if (Array.isArray(raw.tools) && raw.tools.length > 0) {
            results.push({ dir: skillDir, type: 'json' });
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }

  return results;
}

/**
 * Unified skill loader that handles both formats
 */
export async function loadExternalSkillUnified(
  skillDir: string,
  logger: Logger,
  type?: 'json' | 'skillmd'
): Promise<LoadedExternalSkill> {
  // Auto-detect type if not specified
  if (!type) {
    if (hasSkillMd(skillDir)) {
      type = 'skillmd';
    } else {
      type = 'json';
    }
  }

  if (type === 'skillmd') {
    return loadDeclarativeSkill(skillDir, logger);
  }

  // For JSON type, import and call the original loader
  // This avoids circular dependency
  const { loadExternalSkill } = await import('../external-skill-loader');
  return loadExternalSkill(skillDir, logger);
}

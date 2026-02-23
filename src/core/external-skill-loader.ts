import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '../logger';

/**
 * Mirrors the TSC skill.json manifest format.
 */
export interface ExternalSkillManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  requires?: {
    bins?: string[];
    env?: string[];
    config?: string[];
  };
  tools: ExternalToolDef[];
  config?: Record<string, unknown>;
}

/**
 * A single tool entry from the manifest's tools[] array.
 */
export interface ExternalToolDef {
  /** Tool name (matches handler key) */
  name: string;
  /** Some manifests use `id` instead of `name` */
  id?: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Result of loading and validating an external skill.
 */
export interface LoadedExternalSkill {
  manifest: ExternalSkillManifest;
  handlers: Record<string, (args: Record<string, unknown>, context: unknown) => Promise<unknown>>;
  dir: string;
  warnings: string[];
}

/**
 * Scan an array of folder paths, returning all subdirectories that contain
 * a valid skill.json with a `tools[]` array (the external/TSC format).
 */
export function discoverSkillDirs(paths: string[]): string[] {
  const dirs: string[] = [];

  for (const basePath of paths) {
    const absPath = resolve(basePath);
    if (!existsSync(absPath)) continue;

    let entries: string[];
    try {
      entries = readdirSync(absPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(absPath, entry);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const manifestPath = join(skillDir, 'skill.json');
      if (!existsSync(manifestPath)) continue;

      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (Array.isArray(raw.tools) && raw.tools.length > 0) {
          dirs.push(skillDir);
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return dirs;
}

/**
 * Check binary and env requirements from the manifest.
 * Returns an array of warning strings (empty = all good).
 */
export function checkRequirements(manifest: ExternalSkillManifest): string[] {
  const warnings: string[] = [];
  const requires = manifest.requires;
  if (!requires) return warnings;

  if (requires.bins) {
    for (const bin of requires.bins) {
      if (!Bun.which(bin)) {
        warnings.push(`Missing binary: ${bin}`);
      }
    }
  }

  if (requires.env) {
    for (const envVar of requires.env) {
      if (!process.env[envVar]) {
        warnings.push(`Missing env var: ${envVar}`);
      }
    }
  }

  return warnings;
}

/**
 * Parse and normalize the manifest's tools array.
 * Some manifests use `id` instead of `name` as the tool key.
 */
export function normalizeToolDefs(manifest: ExternalSkillManifest): ExternalToolDef[] {
  return manifest.tools.map((t) => ({
    ...t,
    name: t.name || t.id || '',
    parameters: t.parameters ?? { type: 'object', properties: {} },
  }));
}

/**
 * Load an external skill from a directory containing skill.json + index.ts.
 * Reads manifest, validates it, dynamically imports the handler module,
 * and validates that handler keys match tool names.
 */
export async function loadExternalSkill(
  skillDir: string,
  logger: Logger,
): Promise<LoadedExternalSkill> {
  const manifestPath = join(skillDir, 'skill.json');
  const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  if (!raw.id || typeof raw.id !== 'string') {
    throw new Error(`Invalid skill.json in ${skillDir}: missing "id"`);
  }
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    throw new Error(`Invalid skill.json in ${skillDir}: missing or empty "tools" array`);
  }

  const manifest: ExternalSkillManifest = {
    id: raw.id,
    name: raw.name ?? raw.id,
    version: raw.version,
    description: raw.description,
    requires: raw.requires,
    tools: raw.tools,
    config: raw.config,
  };

  const warnings = checkRequirements(manifest);

  // Normalize tool defs (handle id vs name)
  manifest.tools = normalizeToolDefs(manifest);

  // Dynamic import of the handler module
  const handlerPath = join(skillDir, raw.entry ?? 'index.ts');
  if (!existsSync(handlerPath)) {
    throw new Error(`Handler file not found: ${handlerPath}`);
  }

  const mod = await import(`file://${resolve(handlerPath)}`);
  const handlers = mod.handlers ?? mod.default;

  if (!handlers || typeof handlers !== 'object') {
    throw new Error(`No "handlers" export found in ${handlerPath}`);
  }

  // Validate handler keys match tool names
  const toolNames = new Set(manifest.tools.map((t) => t.name));
  for (const toolName of toolNames) {
    if (typeof handlers[toolName] !== 'function') {
      warnings.push(`Tool "${toolName}" declared in manifest but no handler found`);
    }
  }

  const extraHandlers = Object.keys(handlers).filter((k) => !toolNames.has(k));
  if (extraHandlers.length > 0) {
    logger.debug(
      `Skill "${manifest.id}" has extra handler keys not in manifest: ${extraHandlers.join(', ')}`,
    );
  }

  return { manifest, handlers, dir: skillDir, warnings };
}

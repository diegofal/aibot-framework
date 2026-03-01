/**
 * SKILL.md Parser
 * Parses YAML frontmatter + Markdown body into structured SkillDocument
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { DeclaredTool, SkillDocument, SkillManifest, ToolParameter } from './types';
import { SkillParseError } from './types';

export class SkillMdParser {
  /**
   * Parse a SKILL.md file into a structured document
   */
  parse(filePath: string): SkillDocument {
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter, body, frontmatterEndLine } = this.splitFrontmatter(content);

    // Parse YAML frontmatter
    let manifest: SkillManifest;
    try {
      manifest = parseYaml(frontmatter) as SkillManifest;
    } catch (yamlError) {
      const message = yamlError instanceof Error ? yamlError.message : String(yamlError);
      throw new SkillParseError(`Invalid YAML: ${message}`, filePath);
    }

    // Extract tool declarations from Markdown body
    const declaredTools = this.extractToolDeclarations(body);

    return {
      ...manifest,
      instructions: body,
      declaredTools,
      sourcePath: filePath,
    };
  }

  /**
   * Split content into YAML frontmatter and Markdown body
   */
  private splitFrontmatter(content: string): {
    frontmatter: string;
    body: string;
    frontmatterEndLine: number;
  } {
    // Match ---\n...\n---\n pattern (Jekyll-style frontmatter)
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

    if (!match) {
      // Try without trailing newline after second ---
      const altMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\s*([\s\S]*)$/);
      if (!altMatch) {
        throw new Error('Missing YAML frontmatter. File must start with ---');
      }
      const lines = content.substring(0, content.indexOf('---', 3)).split('\n').length;
      return {
        frontmatter: altMatch[1],
        body: altMatch[2].trim(),
        frontmatterEndLine: lines,
      };
    }

    const lines = content.substring(0, content.indexOf('---', 3)).split('\n').length;
    return {
      frontmatter: match[1],
      body: match[2].trim(),
      frontmatterEndLine: lines,
    };
  }

  /**
   * Extract tool declarations from Markdown body
   * Looks for patterns like:
   *
   * ### tool-name
   *
   * **Description:** What the tool does
   * **Parameters:**
   * - `param1` (string, required): Description
   * - `param2` (number, optional): Description, default: `42`
   *
   * **Implementation:** `scripts/tool.ts`
   */
  private extractToolDeclarations(body: string): DeclaredTool[] {
    const tools: DeclaredTool[] = [];

    // Pattern matches ### tool-name sections with Description, Parameters, and optional Implementation
    const toolSectionPattern =
      /###\s+([a-z][a-zA-Z0-9_-]*)\s*\n\n?\*\*Description:\*\*\s*(.+?)(?:\n\n|\n\*\*Parameters:\*\*)/s;

    // Split body into potential tool sections
    const sections = body.split(/(?=###\s+[a-z][a-zA-Z0-9_-]*\s*\n)/);

    for (const section of sections) {
      const tool = this.parseToolSection(section.trim());
      if (tool) {
        tools.push(tool);
      }
    }

    return tools;
  }

  /**
   * Parse a single tool section
   */
  private parseToolSection(section: string): DeclaredTool | null {
    // Match tool header
    const headerMatch = section.match(/^###\s+([a-z][a-zA-Z0-9_-]*)\s*\n/);
    if (!headerMatch) return null;

    const name = headerMatch[1];

    // Extract description
    const descMatch = section.match(/\*\*Description:\*\*\s*(.+?)(?:\n\n|\n\*\*|$)/s);
    const description = descMatch ? descMatch[1].trim() : '';

    // Extract parameters
    const paramsMatch = section.match(/\*\*Parameters:\*\*\s*\n((?:- .+\n?)+)/);
    const parameters = paramsMatch ? this.parseParameters(paramsMatch[1]) : [];

    // Extract implementation path
    const implMatch = section.match(/\*\*Implementation:\*\*\s*`?([^`\n]+)`?/);
    const implementation = implMatch ? implMatch[1].trim() : undefined;

    return {
      name,
      description,
      parameters,
      implementation,
    };
  }

  /**
   * Parse parameter list from markdown
   * Format: - `name` (type, required): description, default: `value`
   */
  private parseParameters(paramsBlock: string): ToolParameter[] {
    const params: ToolParameter[] = [];

    // Match each parameter line
    // - `name` (type, required): description, default: `value`
    // - `name` (type, optional): description
    const paramLines = paramsBlock.split('\n').filter((line) => line.trim().startsWith('-'));

    for (const line of paramLines) {
      const param = this.parseParameterLine(line);
      if (param) {
        params.push(param);
      }
    }

    return params;
  }

  /**
   * Parse a single parameter line
   */
  private parseParameterLine(line: string): ToolParameter | null {
    // Pattern: - `name` (type, required|optional): description, default: value
    const pattern =
      /^-\s+`([^`]+)`\s*\(\s*([^,)]+)\s*,\s*([^)]+)\)\s*:\s*(.+?)(?:,\s*default:\s*(.+))?$/i;
    const match = line.match(pattern);

    if (!match) {
      // Try looser pattern
      const loosePattern = /^-\s+`([^`]+)`\s*\(\s*([^)]+)\)\s*:\s*(.+)$/;
      const looseMatch = line.match(loosePattern);
      if (!looseMatch) return null;

      const [_, name, typeAndReq, rest] = looseMatch;
      const typeParts = typeAndReq.split(',').map((s) => s.trim());
      const type = typeParts[0] as ToolParameter['type'];
      const required = typeParts[1]?.toLowerCase() === 'required';

      return {
        name,
        type: this.validateType(type),
        description: rest.trim(),
        required,
      };
    }

    const [_, name, type, req, description, defaultValue] = match;
    const required = req.trim().toLowerCase() === 'required';

    return {
      name: name.trim(),
      type: this.validateType(type.trim()),
      description: description.trim(),
      required,
      default: defaultValue ? this.parseDefault(defaultValue.trim()) : undefined,
    };
  }

  /**
   * Validate and normalize parameter type
   */
  private validateType(type: string): ToolParameter['type'] {
    const validTypes = ['string', 'number', 'boolean', 'array', 'object'];
    const normalized = type.toLowerCase();
    if (validTypes.includes(normalized)) {
      return normalized as ToolParameter['type'];
    }
    // Default to string for unknown types
    return 'string';
  }

  /**
   * Parse default value from string representation
   */
  private parseDefault(value: string): unknown {
    const trimmed = value.trim();

    // Handle backtick-wrapped values
    if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
      return this.parseDefault(trimmed.slice(1, -1));
    }

    // Boolean
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;

    // Null
    if (trimmed === 'null') return null;

    // Number (integer)
    if (/^-?\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }

    // Number (float)
    if (/^-?\d+\.\d+$/.test(trimmed)) {
      return Number.parseFloat(trimmed);
    }

    // String with quotes
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }

    // Array or object (JSON)
    if (
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }

    // Default: return as string
    return trimmed;
  }
}

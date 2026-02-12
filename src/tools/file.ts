import { resolve, relative } from 'node:path';
import { mkdir, lstat } from 'node:fs/promises';
import type { Tool, ToolResult } from './types';
import type { Logger } from '../logger';

export interface FileToolsConfig {
  basePath: string;
  maxFileSizeBytes?: number;
  deniedPatterns?: string[];
}

/** Default patterns for sensitive files */
const BUILTIN_DENIED = [
  /\.env($|\.)/,
  /credentials/i,
  /\.key$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa/,
  /id_ed25519/,
  /\.ssh\//,
  /shadow$/,
  /\.secret/i,
  /token\.json/i,
];

/**
 * Validate that a resolved path is within the allowed basePath.
 * Blocks path traversal and symlinks that escape the base.
 */
async function validatePath(
  rawPath: string,
  basePath: string,
  deniedPatterns: RegExp[],
): Promise<string | { error: string }> {
  const resolved = resolve(basePath, rawPath);

  // Must be inside basePath
  const rel = relative(basePath, resolved);
  if (rel.startsWith('..') || resolve(basePath, rel) !== resolved) {
    return { error: `Path outside allowed directory: ${rawPath}` };
  }

  // Check denied patterns against the resolved path
  for (const pattern of BUILTIN_DENIED) {
    if (pattern.test(resolved)) {
      return { error: `Access denied: file matches blocked pattern (${pattern})` };
    }
  }
  for (const pattern of deniedPatterns) {
    if (pattern.test(resolved)) {
      return { error: `Access denied: file matches denied pattern (${pattern})` };
    }
  }

  // If the file exists, ensure it's not a symlink escaping basePath
  try {
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink()) {
      const { readlink } = await import('node:fs/promises');
      const target = await readlink(resolved);
      const resolvedTarget = resolve(basePath, target);
      const relTarget = relative(basePath, resolvedTarget);
      if (relTarget.startsWith('..')) {
        return { error: `Symlink escapes allowed directory: ${rawPath}` };
      }
    }
  } catch {
    // File doesn't exist yet — that's fine for writes
  }

  return resolved;
}

// ─── file_read ──────────────────────────────────────────────

export function createFileReadTool(config: FileToolsConfig): Tool {
  const basePath = resolve(config.basePath);
  const maxSize = config.maxFileSizeBytes ?? 1_048_576;
  const denied = (config.deniedPatterns ?? []).map((p) => new RegExp(p));

  return {
    definition: {
      type: 'function',
      function: {
        name: 'file_read',
        description:
          'Read the contents of a file. Returns content with line numbers. ' +
          'Use offset/limit to read a specific range of lines.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path (relative to the allowed base directory)',
            },
            offset: {
              type: 'number',
              description: 'Line number to start reading from (1-based). Optional.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of lines to return. Optional.',
            },
          },
          required: ['path'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const rawPath = String(args.path ?? '').trim();
      if (!rawPath) {
        return { success: false, content: 'Missing required parameter: path' };
      }

      const validated = await validatePath(rawPath, basePath, denied);
      if (typeof validated === 'object') {
        logger.warn({ path: rawPath, reason: validated.error }, 'file_read: blocked');
        return { success: false, content: validated.error };
      }

      try {
        const file = Bun.file(validated);

        // Check size before reading
        const size = file.size;
        if (size > maxSize) {
          return {
            success: false,
            content: `File too large: ${size} bytes (max ${maxSize} bytes). Use offset/limit to read a portion.`,
          };
        }

        const text = await file.text();
        const allLines = text.split('\n');

        const offset = Math.max(1, Number(args.offset) || 1);
        const limit = Number(args.limit) || allLines.length;

        const sliced = allLines.slice(offset - 1, offset - 1 + limit);
        const numbered = sliced
          .map((line, i) => `${String(offset + i).padStart(5)} | ${line}`)
          .join('\n');

        const header = `File: ${rawPath} (${allLines.length} lines, ${size} bytes)`;
        logger.info({ path: rawPath, lines: sliced.length }, 'file_read: success');
        return { success: true, content: `${header}\n${numbered}` };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('No such file') || msg.includes('ENOENT')) {
          return { success: false, content: `File not found: ${rawPath}` };
        }
        logger.error({ error: msg, path: rawPath }, 'file_read: failed');
        return { success: false, content: `Failed to read file: ${msg}` };
      }
    },
  };
}

// ─── file_write ─────────────────────────────────────────────

export function createFileWriteTool(config: FileToolsConfig): Tool {
  const basePath = resolve(config.basePath);
  const maxSize = config.maxFileSizeBytes ?? 1_048_576;
  const denied = (config.deniedPatterns ?? []).map((p) => new RegExp(p));

  return {
    definition: {
      type: 'function',
      function: {
        name: 'file_write',
        description:
          'Write content to a file. Creates the file if it doesn\'t exist, or overwrites it. ' +
          'Set append=true to append instead of overwriting. Creates intermediate directories automatically.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path (relative to the allowed base directory)',
            },
            content: {
              type: 'string',
              description: 'The content to write to the file',
            },
            append: {
              type: 'boolean',
              description: 'If true, append to existing file instead of overwriting. Default: false.',
            },
          },
          required: ['path', 'content'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const rawPath = String(args.path ?? '').trim();
      const content = String(args.content ?? '');
      const append = Boolean(args.append);

      if (!rawPath) {
        return { success: false, content: 'Missing required parameter: path' };
      }

      if (content.length > maxSize) {
        return {
          success: false,
          content: `Content too large: ${content.length} bytes (max ${maxSize} bytes)`,
        };
      }

      const validated = await validatePath(rawPath, basePath, denied);
      if (typeof validated === 'object') {
        logger.warn({ path: rawPath, reason: validated.error }, 'file_write: blocked');
        return { success: false, content: validated.error };
      }

      try {
        // Ensure parent directory exists
        const dir = validated.substring(0, validated.lastIndexOf('/'));
        if (dir) {
          await mkdir(dir, { recursive: true });
        }

        if (append) {
          // Read existing content and append
          let existing = '';
          try {
            existing = await Bun.file(validated).text();
          } catch {
            // File doesn't exist yet, that's fine
          }
          await Bun.write(validated, existing + content);
        } else {
          await Bun.write(validated, content);
        }

        const action = append ? 'appended to' : 'written to';
        logger.info({ path: rawPath, bytes: content.length, append }, 'file_write: success');
        return {
          success: true,
          content: `Successfully ${action} ${rawPath} (${content.length} bytes)`,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg, path: rawPath }, 'file_write: failed');
        return { success: false, content: `Failed to write file: ${msg}` };
      }
    },
  };
}

// ─── file_edit ──────────────────────────────────────────────

export function createFileEditTool(config: FileToolsConfig): Tool {
  const basePath = resolve(config.basePath);
  const denied = (config.deniedPatterns ?? []).map((p) => new RegExp(p));

  return {
    definition: {
      type: 'function',
      function: {
        name: 'file_edit',
        description:
          'Edit an existing file by replacing exact text. Searches for old_text and replaces it with new_text. ' +
          'Fails if old_text is not found or appears multiple times (unless replace_all is true). ' +
          'Prefer this over file_write when modifying existing files to avoid losing content.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path (relative to the allowed base directory)',
            },
            old_text: {
              type: 'string',
              description: 'The exact text to find in the file',
            },
            new_text: {
              type: 'string',
              description: 'The text to replace old_text with',
            },
            replace_all: {
              type: 'boolean',
              description: 'If true, replace all occurrences. Default: false (requires unique match).',
            },
          },
          required: ['path', 'old_text', 'new_text'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const rawPath = String(args.path ?? '').trim();
      const oldText = String(args.old_text ?? '');
      const newText = String(args.new_text ?? '');
      const replaceAll = Boolean(args.replace_all);

      if (!rawPath) {
        return { success: false, content: 'Missing required parameter: path' };
      }
      if (!oldText) {
        return { success: false, content: 'Missing required parameter: old_text' };
      }

      const validated = await validatePath(rawPath, basePath, denied);
      if (typeof validated === 'object') {
        logger.warn({ path: rawPath, reason: validated.error }, 'file_edit: blocked');
        return { success: false, content: validated.error };
      }

      try {
        const file = Bun.file(validated);
        const content = await file.text();

        // Count occurrences
        let count = 0;
        let idx = 0;
        while ((idx = content.indexOf(oldText, idx)) !== -1) {
          count++;
          idx += oldText.length;
        }

        if (count === 0) {
          return {
            success: false,
            content: 'old_text not found in file. Make sure the text matches exactly (including whitespace).',
          };
        }

        if (count > 1 && !replaceAll) {
          return {
            success: false,
            content: `old_text found ${count} times. Use replace_all=true to replace all occurrences, or provide a more specific old_text.`,
          };
        }

        let newContent: string;
        if (replaceAll) {
          newContent = content.split(oldText).join(newText);
        } else {
          // Replace first (and only) occurrence
          const pos = content.indexOf(oldText);
          newContent = content.substring(0, pos) + newText + content.substring(pos + oldText.length);
        }

        await Bun.write(validated, newContent);

        logger.info(
          { path: rawPath, replacements: replaceAll ? count : 1 },
          'file_edit: success'
        );
        return {
          success: true,
          content: `Successfully edited ${rawPath} (${replaceAll ? count : 1} replacement${count > 1 && replaceAll ? 's' : ''})`,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('No such file') || msg.includes('ENOENT')) {
          return { success: false, content: `File not found: ${rawPath}` };
        }
        logger.error({ error: msg, path: rawPath }, 'file_edit: failed');
        return { success: false, content: `Failed to edit file: ${msg}` };
      }
    },
  };
}

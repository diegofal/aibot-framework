import { join } from 'node:path';
import type { Tool, ToolResult } from './types';
import type { DynamicToolMeta } from './dynamic-tool-store';
import type { Logger } from '../logger';

const TOOL_TIMEOUT_MS = 30_000;

/**
 * Converts a DynamicToolMeta + source code into a Tool instance.
 * TypeScript tools: run via Bun subprocess.
 * Command tools: interpolate parameters and run via shell.
 */
export function loadDynamicTool(
  meta: DynamicToolMeta,
  source: string,
  storePath: string,
): Tool {
  // Build parameter schema from meta.parameters
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(meta.parameters)) {
    properties[name] = {
      type: param.type,
      description: param.description,
    };
    if (param.required) {
      required.push(name);
    }
  }

  return {
    definition: {
      type: 'function',
      function: {
        name: meta.name,
        description: meta.description,
        parameters: {
          type: 'object',
          properties,
          required: required.length > 0 ? required : undefined,
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      // Strip internal args
      const cleanArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (!k.startsWith('_')) cleanArgs[k] = v;
      }

      try {
        if (meta.type === 'typescript') {
          return await executeTypeScript(meta, cleanArgs, storePath, logger);
        } else {
          return await executeCommand(meta, source, cleanArgs, logger);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ tool: meta.name, error: msg }, 'Dynamic tool execution failed');
        return { success: false, content: `Tool error: ${msg}` };
      }
    },
  };
}

async function executeTypeScript(
  meta: DynamicToolMeta,
  args: Record<string, unknown>,
  storePath: string,
  logger: Logger,
): Promise<ToolResult> {
  const toolPath = join(storePath, meta.id, 'tool.ts');

  const proc = Bun.spawn(['bun', 'run', toolPath, JSON.stringify(args)], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`Tool timed out after ${TOOL_TIMEOUT_MS}ms`));
    }, TOOL_TIMEOUT_MS);
  });

  const resultPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      logger.warn({ tool: meta.name, exitCode, stderr: stderr.slice(0, 500) }, 'Dynamic tool non-zero exit');
      return { success: false, content: stderr || `Exit code: ${exitCode}` };
    }

    // Try to parse as JSON for structured output
    const trimmed = stdout.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && 'success' in parsed && 'content' in parsed) {
        return parsed as ToolResult;
      }
      return { success: true, content: JSON.stringify(parsed) };
    } catch {
      return { success: true, content: trimmed || '(no output)' };
    }
  })();

  return Promise.race([resultPromise, timeoutPromise]);
}

async function executeCommand(
  meta: DynamicToolMeta,
  template: string,
  args: Record<string, unknown>,
  logger: Logger,
): Promise<ToolResult> {
  // Interpolate {{param}} placeholders
  let command = template;
  for (const [key, value] of Object.entries(args)) {
    // Sanitize value to prevent injection
    const sanitized = String(value).replace(/[;&|`$(){}]/g, '');
    command = command.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), sanitized);
  }

  // Reject if unresolved placeholders remain
  if (/\{\{[^}]+\}\}/.test(command)) {
    return { success: false, content: 'Missing required parameters in command template' };
  }

  logger.debug({ tool: meta.name, command: command.slice(0, 200) }, 'Executing dynamic command');

  const proc = Bun.spawn(['sh', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out after ${TOOL_TIMEOUT_MS}ms`));
    }, TOOL_TIMEOUT_MS);
  });

  const resultPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return { success: false, content: stderr || `Exit code: ${exitCode}` };
    }

    return { success: true, content: stdout.trim() || '(no output)' };
  })();

  return Promise.race([resultPromise, timeoutPromise]);
}

import type { Tool, ToolResult } from './types';
import type { Logger } from '../logger';
import { registerProcess, type ProcessToolConfig } from './process';

export interface ExecToolConfig {
  timeout?: number;
  maxOutputLength?: number;
  workdir?: string;
  allowedPatterns?: string[];
  deniedPatterns?: string[];
  processToolConfig?: ProcessToolConfig;
}

/** Commands that are always blocked regardless of config */
const BUILTIN_DENIED = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,  // rm -rf / or rm /
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /:(){ :|:& };:/,                                // fork bomb
  /\b>\s*\/dev\/sd[a-z]/,
  /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[06]\b/,
];

function isBlocked(command: string, deniedPatterns: RegExp[]): string | null {
  for (const pattern of BUILTIN_DENIED) {
    if (pattern.test(command)) {
      return `Command blocked by safety rule: ${pattern}`;
    }
  }
  for (const pattern of deniedPatterns) {
    if (pattern.test(command)) {
      return `Command blocked by deny pattern: ${pattern}`;
    }
  }
  return null;
}

function isAllowed(command: string, allowedPatterns: RegExp[]): boolean {
  if (allowedPatterns.length === 0) return true;
  return allowedPatterns.some((p) => p.test(command));
}

export function createExecTool(config: ExecToolConfig = {}): Tool {
  const timeout = config.timeout ?? 30_000;
  const maxOutput = config.maxOutputLength ?? 10_000;
  const workdir = config.workdir ?? process.cwd();

  const denied = (config.deniedPatterns ?? []).map((p) => new RegExp(p));
  const allowed = (config.allowedPatterns ?? []).map((p) => new RegExp(p));

  return {
    definition: {
      type: 'function',
      function: {
        name: 'exec',
        description:
          'Execute a shell command on the host machine and return stdout/stderr. ' +
          'Use this for system tasks like checking disk space, listing files, running scripts, ' +
          'installing packages, git operations, etc. Commands run in a bash shell. ' +
          'Set background=true for long-running commands — returns a session ID you can manage with the process tool.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The shell command to execute (e.g. "ls -la", "df -h", "git status")',
            },
            workdir: {
              type: 'string',
              description: 'Working directory for the command. Optional, defaults to the bot\'s working directory.',
            },
            background: {
              type: 'boolean',
              description: 'If true, run the command in background and return a session ID. Use the process tool to poll output, send input, or kill it. Default: false.',
            },
          },
          required: ['command'],
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger
    ): Promise<ToolResult> {
      const command = String(args.command ?? '').trim();
      if (!command) {
        return { success: false, content: 'Missing required parameter: command' };
      }

      // Safety checks
      const blockReason = isBlocked(command, denied);
      if (blockReason) {
        logger.warn({ command, reason: blockReason }, 'exec: command blocked');
        return { success: false, content: blockReason };
      }

      if (!isAllowed(command, allowed)) {
        logger.warn({ command }, 'exec: command not in allowlist');
        return { success: false, content: 'Command not permitted by allowlist' };
      }

      const cwd = String(args.workdir ?? workdir);
      const background = Boolean(args.background);

      // Background mode: register and return immediately
      if (background && config.processToolConfig) {
        try {
          logger.info({ command, cwd }, 'exec: starting background process');
          const proc = Bun.spawn(['bash', '-c', command], {
            cwd,
            stdout: 'pipe',
            stderr: 'pipe',
            stdin: 'pipe',
            env: { ...process.env, TERM: 'dumb' },
          });

          const { sessionId, pid } = registerProcess(
            command,
            proc,
            config.processToolConfig,
            logger,
          );

          return {
            success: true,
            content: `Background process started.\nSession ID: ${sessionId}\nPID: ${pid}\n\nUse the process tool to poll output, send input, or kill it.`,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ error: message, command }, 'exec: background start failed');
          return { success: false, content: `Failed to start background process: ${message}` };
        }
      }

      try {
        logger.info({ command, cwd, timeout }, 'exec: running command');

        const proc = Bun.spawn(['bash', '-c', command], {
          cwd,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, TERM: 'dumb' },
        });

        // Enforce timeout
        const timer = setTimeout(() => {
          try { proc.kill(); } catch {}
        }, timeout);

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        clearTimeout(timer);

        // Build output
        let output = '';
        if (stdout.trim()) output += stdout;
        if (stderr.trim()) output += (output ? '\n--- stderr ---\n' : '') + stderr;
        if (!output.trim()) output = '(no output)';

        // Truncate if too long
        if (output.length > maxOutput) {
          output = output.slice(0, maxOutput) + `\n... (truncated, ${output.length} total chars)`;
        }

        const content = `Exit code: ${exitCode}\n\n${output}`;

        logger.info(
          { command, exitCode, outputLength: output.length },
          'exec: command completed'
        );

        return { success: exitCode === 0, content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message, command }, 'exec: command failed');
        return { success: false, content: `Command execution failed: ${message}` };
      }
    },
  };
}

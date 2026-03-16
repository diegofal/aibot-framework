import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TokenUsage } from './core/llm-client';
import type { Logger } from './logger';
import type { ToolDefinition, ToolExecutor } from './tools/types';

/** Extract TokenUsage from Claude CLI JSON output's usage field. */
function parseClaudeUsage(parsed: Record<string, unknown>): TokenUsage | undefined {
  const usage = parsed.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  if (!usage || (usage.input_tokens == null && usage.output_tokens == null)) return undefined;
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  const model = (typeof parsed.model === 'string' ? parsed.model : null) ?? 'claude';
  return { model, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

export interface ClaudeGenerateOptions {
  claudePath?: string;
  model?: string;
  timeout?: number;
  maxLength?: number;
  systemPrompt?: string;
}

const DEFAULT_CLAUDE_PATH = 'claude';
const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_MAX_LENGTH = 50_000;

/**
 * Spawn Claude CLI in prompt mode and return the text output + usage.
 * Uses --output-format json to capture token usage metadata.
 * Throws on timeout, non-zero exit, or empty output so callers can fall back.
 */
export async function claudeGenerate(
  prompt: string,
  opts: ClaudeGenerateOptions & { logger: Logger }
): Promise<{ response: string; usage?: TokenUsage }> {
  const claudePath = opts.claudePath || DEFAULT_CLAUDE_PATH;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;

  // Clear CLAUDECODE env to avoid nested session detection (same as improve.ts)
  const env = { ...process.env };
  env.CLAUDECODE = undefined;
  env.TERM = 'dumb';

  const args = [claudePath, '-p', prompt, '--output-format', 'json'];
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  const proc = Bun.spawn(args, {
    cwd: tmpdir(), // Isolated dir — no CLAUDE.md, no auto-memory leakage
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, timeout);

  const startTime = Date.now();

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (exitCode !== 0) {
      const durationMs = Date.now() - startTime;
      const isTimeout = exitCode === 143 || exitCode === 137; // SIGTERM or SIGKILL
      const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;

      opts.logger.warn(
        {
          exitCode,
          durationMs,
          isTimeout,
          stdoutLen: stdout.length,
          stderrLen: stderr.length,
        },
        'Claude CLI failed'
      );

      throw new Error(`Claude CLI exited with code ${exitCode}: ${detail}`);
    }

    let output: string;
    let usage: TokenUsage | undefined;
    const raw = stdout.trim();

    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') {
        output = parsed;
      } else {
        output = parsed.result ?? parsed.content ?? parsed.text ?? raw;
        usage = parseClaudeUsage(parsed);
      }
    } catch {
      output = raw;
    }

    if (!output) {
      throw new Error('Claude CLI produced no output');
    }

    if (output.length > maxLength) {
      output = output.slice(0, maxLength);
    }

    opts.logger.info(
      { durationMs: Date.now() - startTime, outputLen: output.length },
      'Claude CLI completed'
    );

    return { response: output, usage };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export interface ClaudeToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
}

export interface ClaudeGenerateWithToolsOptions extends ClaudeGenerateOptions {
  tools: ToolDefinition[];
  toolExecutor: ToolExecutor;
  /** Claude CLI native tools to block via --disallowedTools (e.g. 'Bash', 'Write'). */
  disallowedNativeTools?: string[];
}

/**
 * Convert our OpenAI-style ToolDefinition to MCP tool format.
 */
function toMcpToolDefs(tools: ToolDefinition[]): Array<{
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}> {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: {
      type: 'object' as const,
      properties: t.function.parameters.properties,
      required: t.function.parameters.required,
    },
  }));
}

/**
 * Run Claude CLI with tool calling via an MCP bridge.
 *
 * 1. Starts a temp HTTP callback server wrapping toolExecutor
 * 2. Writes tool defs + MCP config to temp files
 * 3. Spawns Claude CLI with --mcp-config for the bridge
 * 4. Claude CLI handles multi-turn tool loop internally via MCP
 * 5. Returns the final text response + tool call trace
 */
export async function claudeGenerateWithTools(
  prompt: string,
  opts: ClaudeGenerateWithToolsOptions & { logger: Logger }
): Promise<{ response: string; toolCalls: ClaudeToolCallRecord[]; usage?: TokenUsage }> {
  const claudePath = opts.claudePath || DEFAULT_CLAUDE_PATH;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  const toolCalls: ClaudeToolCallRecord[] = [];

  // Create temp directory for MCP config files
  const tmpDir = await mkdtemp(join(tmpdir(), 'aibot-mcp-'));

  // Start callback server wrapping toolExecutor
  const callbackServer = Bun.serve({
    port: 0, // OS-assigned port
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/call') {
        return new Response('Not found', { status: 404 });
      }
      try {
        const body = (await req.json()) as { name: string; arguments: Record<string, unknown> };
        const result = await opts.toolExecutor(body.name, body.arguments ?? {});
        toolCalls.push({
          name: body.name,
          args: body.arguments ?? {},
          result: result.content,
          success: result.success,
        });
        return Response.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const result = { success: false, content: `Executor error: ${msg}` };
        toolCalls.push({ name: '(unknown)', args: {}, result: result.content, success: false });
        return Response.json(result);
      }
    },
  });

  try {
    const callbackPort = callbackServer.port;

    // Write tool definitions file
    const toolDefsPath = join(tmpDir, 'tools.json');
    const mcpDefs = toMcpToolDefs(opts.tools);
    await Bun.write(toolDefsPath, JSON.stringify(mcpDefs));

    // Write MCP config
    const bridgePath = resolve(import.meta.dir, 'mcp/tool-bridge-server.ts');
    const mcpConfig = {
      mcpServers: {
        'aibot-tools': {
          command: 'bun',
          args: ['run', bridgePath],
          env: {
            TOOL_DEFS_FILE: toolDefsPath,
            CALLBACK_PORT: String(callbackPort),
          },
        },
      },
    };
    const mcpConfigPath = join(tmpDir, 'mcp-config.json');
    await Bun.write(mcpConfigPath, JSON.stringify(mcpConfig));

    // Clear CLAUDECODE env to avoid nested session detection
    const env = { ...process.env };
    env.CLAUDECODE = undefined;
    env.TERM = 'dumb';

    // Build --allowedTools pattern to restrict Claude to only our MCP tools.
    // Claude CLI names MCP tools as "mcp__<server>__<tool>".
    const allowedTools = mcpDefs.map((t) => `mcp__aibot-tools__${t.name}`);

    const args = [
      claudePath,
      '-p',
      prompt,
      '--output-format',
      'json',
      '--mcp-config',
      mcpConfigPath,
      '--no-session-persistence',
      '--allowedTools',
      allowedTools.join(','),
    ];
    if (opts.disallowedNativeTools && opts.disallowedNativeTools.length > 0) {
      args.push('--disallowedTools', opts.disallowedNativeTools.join(','));
    }
    if (opts.model) {
      args.push('--model', opts.model);
    }
    if (opts.systemPrompt) {
      args.push('--system-prompt', opts.systemPrompt);
    }

    opts.logger.info(
      { toolCount: opts.tools.length, callbackPort, tmpDir },
      'Claude CLI: starting MCP tool bridge'
    );

    const proc = Bun.spawn(args, {
      cwd: tmpdir(), // Isolated dir — no CLAUDE.md, no auto-memory leakage
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, timeout);

    const startTime = Date.now();

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (exitCode !== 0) {
      const durationMs = Date.now() - startTime;
      const isTimeout = exitCode === 143 || exitCode === 137;
      const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;

      opts.logger.warn(
        {
          exitCode,
          durationMs,
          isTimeout,
          toolCalls: toolCalls.length,
        },
        'Claude CLI (MCP tools) failed'
      );

      throw new Error(`Claude CLI exited with code ${exitCode}: ${detail}`);
    }

    // Parse JSON output — Claude CLI --output-format json wraps result
    let response: string;
    let usage: TokenUsage | undefined;
    try {
      const parsed = JSON.parse(stdout.trim());
      if (typeof parsed === 'string') {
        response = parsed;
      } else {
        response = parsed.result ?? parsed.content ?? parsed.text ?? stdout.trim();
        usage = parseClaudeUsage(parsed);
      }
    } catch {
      // Fallback: treat as plain text if JSON parsing fails
      response = stdout.trim();
    }

    if (!response) {
      throw new Error('Claude CLI (MCP tools) produced no output');
    }

    if (response.length > maxLength) {
      response = response.slice(0, maxLength);
    }

    opts.logger.info(
      {
        durationMs: Date.now() - startTime,
        outputLen: response.length,
        toolCalls: toolCalls.length,
      },
      'Claude CLI (MCP tools) completed'
    );

    return { response, toolCalls, usage };
  } finally {
    callbackServer.stop(true);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

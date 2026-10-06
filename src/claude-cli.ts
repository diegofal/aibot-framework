import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TokenUsage } from './core/llm-client';
import type { Logger } from './logger';
import type { ToolDefinition, ToolExecutor } from './tools/types';

/** Extract TokenUsage from Claude CLI JSON output's usage field. */
/**
 * The model that did the work, from the result's `modelUsage` (keyed by model
 * id; the CLI has no top-level `model`). The map also lists the CLI's own
 * auxiliary Haiku calls, so the entry with the most tokens — cached prompt
 * included — wins. Null when the map is absent or empty.
 */
function pickModelFromUsage(modelUsage: unknown): string | null {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return null;
  let best: string | null = null;
  let bestTokens = -1;
  for (const [model, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const n = (k: string) => (typeof e[k] === 'number' ? (e[k] as number) : 0);
    const total =
      n('inputTokens') +
      n('outputTokens') +
      n('cacheReadInputTokens') +
      n('cacheCreationInputTokens');
    if (total > bestTokens) {
      best = model;
      bestTokens = total;
    }
  }
  return best;
}

export function parseClaudeUsage(parsed: Record<string, unknown>): TokenUsage | undefined {
  const usage = parsed.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  if (!usage || (usage.input_tokens == null && usage.output_tokens == null)) return undefined;
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  const model =
    (typeof parsed.model === 'string' ? parsed.model : null) ??
    pickModelFromUsage(parsed.modelUsage) ??
    'claude';
  return { model, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

export interface ClaudeGenerateOptions {
  claudePath?: string;
  model?: string;
  timeout?: number;
  maxLength?: number;
  systemPrompt?: string;
  /**
   * Base64 images sent to the model as image blocks. When present the prompt
   * goes on stdin as stream-json instead of as the `-p` argument.
   */
  images?: string[];
}

/** Media type from the image's magic bytes; Telegram photos are JPEG, so that is the fallback. */
export function sniffImageMediaType(base64: string): string {
  const head = Buffer.from(base64.slice(0, 24), 'base64');
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return 'image/png';
  }
  if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

/** One stream-json user message: the image blocks, then the prompt text. */
export function buildStreamJsonUserMessage(prompt: string, images: string[]): string {
  const content = [
    ...images.map((data) => ({
      type: 'image',
      source: { type: 'base64', media_type: sniffImageMediaType(data), data },
    })),
    { type: 'text', text: prompt },
  ];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

/**
 * The CLI args that carry the prompt, plus stdin when it goes there. Text-only
 * prompts stay on `-p <prompt>` with json output; a prompt with images goes on
 * stdin as stream-json (the only way the CLI takes image blocks), which needs
 * stream-json output and `--verbose`.
 */
export function buildClaudePromptInput(
  prompt: string,
  images?: string[]
): { args: string[]; stdin?: string } {
  if (!images || images.length === 0) {
    return { args: ['-p', prompt, '--output-format', 'json'] };
  }
  return {
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    stdin: buildStreamJsonUserMessage(prompt, images),
  };
}

/**
 * The `type: "result"` event out of stream-json stdout. It has the same shape
 * as `--output-format json`, so the usual parsing applies to it. Stdout comes
 * back unchanged when there is no such event.
 */
export function extractStreamJsonResult(stdout: string): string {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === 'result') return line;
    } catch {}
  }
  return stdout;
}

/** Structured fields lifted out of the CLI's `--output-format json` result object. */
export interface ClaudeCliResultFields {
  /** HTTP status the CLI reported for the upstream API call (e.g. 429). */
  apiErrorStatus?: number;
  isError?: boolean;
  /** e.g. `api_error`. */
  terminalReason?: string;
  /** The human-facing `result` string. */
  resultText?: string;
  /** Absolute instant parsed out of a `resets <time>` hint in `resultText`. */
  resetsAt?: Date;
}

/**
 * A non-zero Claude CLI exit, carrying whatever the CLI told us in structured
 * form.
 *
 * The `message` is deliberately kept in the historical
 * `Claude CLI exited with code N: <detail>` shape so logs and existing tests
 * still read well — but callers must classify on the typed fields, never on
 * the message. The raw JSON blob contains keys such as `permission_denials`
 * that look like auth failures to a naive substring matcher, which is how a
 * rate limit used to be mistaken for a permanent credential error.
 */
export class ClaudeCliError extends Error {
  readonly exitCode: number;
  readonly apiErrorStatus?: number;
  readonly isError?: boolean;
  readonly terminalReason?: string;
  readonly resultText?: string;
  readonly resetsAt?: Date;
  /** True when our own timer killed the process (not a crash that happened to exit 143). */
  readonly timedOut: boolean;

  constructor(
    message: string,
    exitCode: number,
    fields: ClaudeCliResultFields = {},
    timedOut = false
  ) {
    super(message);
    this.name = 'ClaudeCliError';
    this.exitCode = exitCode;
    this.timedOut = timedOut;
    this.apiErrorStatus = fields.apiErrorStatus;
    this.isError = fields.isError;
    this.terminalReason = fields.terminalReason;
    this.resultText = fields.resultText;
    this.resetsAt = fields.resetsAt;
  }
}

/** `resets 12:20pm`, `resets 9am`, `resets 14:20` — meridiem optional. */
const RESETS_TIME_PATTERN = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
/** The IANA zone the CLI parenthesises after the time. */
const RESETS_TZ_PATTERN = /resets[^(]*\(([^)]+)\)/i;

/** Offset (ms) between a zone's wall clock and UTC at a given instant. */
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );
  // Zone offsets are always whole minutes; rounding drops the sub-second
  // remainder of `instant` so the computed reset lands on an exact minute.
  return Math.round((asUtc - instant.getTime()) / 60_000) * 60_000;
}

/** Next instant at which the named zone's wall clock reads hour:minute. */
function zonedNextOccurrence(
  hour: number,
  minute: number,
  timeZone: string,
  now: Date
): Date | undefined {
  try {
    const offset = timeZoneOffsetMs(now, timeZone);
    const wallNow = new Date(now.getTime() + offset);
    const year = wallNow.getUTCFullYear();
    const month = wallNow.getUTCMonth();
    const day = wallNow.getUTCDate();

    for (const dayShift of [0, 1]) {
      const wallTarget = Date.UTC(year, month, day + dayShift, hour, minute, 0, 0);
      // One refinement pass covers DST transitions between the two instants.
      let ts = wallTarget - offset;
      ts = wallTarget - timeZoneOffsetMs(new Date(ts), timeZone);
      if (ts > now.getTime()) return new Date(ts);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Same, on the host's local clock — used when no usable zone was given. */
function localNextOccurrence(hour: number, minute: number, now: Date): Date {
  const at = new Date(now.getTime());
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * Parse a `resets <time> (<zone>)` hint into an absolute instant.
 *
 * Defensive by construction: anything unparseable yields `undefined` and
 * nothing ever throws. A time that has already passed today means tomorrow.
 */
export function parseResetsAt(text: string, now: Date = new Date()): Date | undefined {
  try {
    if (!text) return undefined;
    const match = RESETS_TIME_PATTERN.exec(text);
    if (!match) return undefined;

    let hour = Number(match[1]);
    const minute = match[2] ? Number(match[2]) : 0;
    const meridiem = match[3]?.toLowerCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return undefined;

    if (meridiem) {
      if (hour < 1 || hour > 12) return undefined;
      if (meridiem === 'pm' && hour !== 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
    } else if (hour > 23) {
      return undefined;
    }

    const timeZone = RESETS_TZ_PATTERN.exec(text)?.[1]?.trim();
    const zoned = timeZone ? zonedNextOccurrence(hour, minute, timeZone, now) : undefined;
    return zoned ?? localNextOccurrence(hour, minute, now);
  } catch {
    return undefined;
  }
}

/** Lift the structured fields out of a CLI result JSON blob; `{}` when it isn't one. */
function parseClaudeResultFields(raw: string, now?: Date): ClaudeCliResultFields {
  const text = raw?.trim();
  if (!text || text[0] !== '{') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const obj = parsed as Record<string, unknown>;
  const looksLikeResult =
    obj.type === 'result' ||
    'is_error' in obj ||
    'subtype' in obj ||
    'api_error_status' in obj ||
    'terminal_reason' in obj ||
    'result' in obj;
  if (!looksLikeResult) return {};

  const fields: ClaudeCliResultFields = {};
  const status = obj.api_error_status;
  if (typeof status === 'number' && Number.isFinite(status)) fields.apiErrorStatus = status;
  else if (typeof status === 'string' && /^\d{3}$/.test(status))
    fields.apiErrorStatus = Number(status);
  if (typeof obj.is_error === 'boolean') fields.isError = obj.is_error;
  if (typeof obj.terminal_reason === 'string') fields.terminalReason = obj.terminal_reason;
  if (typeof obj.result === 'string') {
    fields.resultText = obj.result;
    fields.resetsAt = parseResetsAt(obj.result, now);
  }
  return fields;
}

/**
 * Build the typed error for a non-zero CLI exit.
 *
 * `detail` is what goes into the message (stderr when present, stdout
 * otherwise); `rawStdout` is always searched for the JSON result object, so a
 * structured rate limit is still recognised when stderr carried the message.
 */
export function createClaudeCliError(
  exitCode: number,
  detail: string,
  rawStdout: string,
  opts: { now?: Date; timedOutAfterMs?: number } = {}
): ClaudeCliError {
  const fromStdout = parseClaudeResultFields(rawStdout, opts.now);
  const fields =
    Object.keys(fromStdout).length > 0 ? fromStdout : parseClaudeResultFields(detail, opts.now);
  // A kill by our own timer exits 143 with no output. Say "timed out" so the
  // retry engine reads it as TRANSIENT instead of UNKNOWN.
  if (opts.timedOutAfterMs != null) {
    return new ClaudeCliError(
      `Claude CLI timed out after ${opts.timedOutAfterMs}ms (exit ${exitCode}): ${detail}`,
      exitCode,
      fields,
      true
    );
  }
  return new ClaudeCliError(`Claude CLI exited with code ${exitCode}: ${detail}`, exitCode, fields);
}

/**
 * Permission-bypass flag for headless runs.
 *
 * Claude Code parses flags with commander, which does not accept a camelCase
 * spelling of a kebab-case option: `--dangerouslySkipPermissions` is rejected
 * with `error: unknown option` and the spawn dies before reaching the model.
 * Exported so every call site spells it the one way that works.
 */
export const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * Model aliases the installed Claude CLI accepts for `--model` (`claude --help`
 * documents them as rolling aliases for the latest release of each tier), plus
 * the empty value meaning "omit --model and let the CLI use its own default".
 * This is the single source of truth for any UI offering a model choice for
 * the claude-cli backend — never hardcode the list a second time.
 */
export const CLAUDE_CLI_MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: "CLI default (whatever's configured on the container)" },
  // Rolling aliases: the CLI resolves each to the newest release of that tier.
  { value: 'opus', label: 'Opus (latest) — most capable' },
  { value: 'sonnet', label: 'Sonnet (latest) — balanced' },
  { value: 'haiku', label: 'Haiku (latest) — fastest, cheapest' },
  { value: 'fable', label: 'Fable (latest) — newest tier, above Opus' },
  // Pinned ids: stay on one generation even when the alias moves. The 5.5 /
  // Fable 5.1 ids need CLI >= 2.1.280 (older builds answer 400 "does not
  // support this model") — see CLAUDE_CLI_VERSION in the Dockerfile.
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (pinned) — recommended default' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5 (pinned)' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1 (pinned)' },
  { value: 'claude-opus-5', label: 'Opus 5 (pinned)' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 (pinned)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (pinned)' },
];

const DEFAULT_CLAUDE_PATH = 'claude';
const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_MAX_LENGTH = 50_000;

/** Looks up an executable the way `Bun.which` does; injectable so tests stay hermetic. */
export type WhichFn = (command: string) => string | null;

const EXECUTABLE_SUFFIX = /\.(cmd|exe|bat)$/i;

/**
 * Resolve the claude binary path for the current platform.
 *
 * On Windows, Bun.spawn (libuv) can't execute npm's extensionless `.sh` shim, so an
 * npm-installed CLI must be spawned through its sibling `claude.cmd` wrapper. A winget
 * install ships a native `claude.exe` and has no `.cmd` at all, so appending the suffix
 * unconditionally turns a working spawn into ENOENT. Probe the PATH instead and only
 * rewrite when the `.cmd` wrapper actually exists; otherwise leave the path alone and
 * let libuv resolve it (which finds `.exe`).
 */
export function resolveClaudeBin(path: string, which: WhichFn = (cmd) => Bun.which(cmd)): string {
  if (process.platform !== 'win32') return path;
  if (EXECUTABLE_SUFFIX.test(path)) return path;
  return which(`${path}.cmd`) ? `${path}.cmd` : path;
}

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

  const input = buildClaudePromptInput(prompt, opts.images);
  const args = [resolveClaudeBin(claudePath), ...input.args, SKIP_PERMISSIONS_FLAG];
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
    ...(input.stdin !== undefined && { stdin: new TextEncoder().encode(input.stdin) }),
  });

  let killedByTimer = false;
  const timer = setTimeout(() => {
    killedByTimer = true;
    try {
      proc.kill();
    } catch {}
  }, timeout);

  const startTime = Date.now();

  try {
    const [rawStdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const stdout = input.stdin === undefined ? rawStdout : extractStreamJsonResult(rawStdout);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (exitCode !== 0) {
      const durationMs = Date.now() - startTime;
      const isTimeout = killedByTimer && (exitCode === 143 || exitCode === 137); // SIGTERM or SIGKILL
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

      throw createClaudeCliError(exitCode, detail, stdout, {
        timedOutAfterMs: isTimeout ? timeout : undefined,
      });
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

    const input = buildClaudePromptInput(prompt, opts.images);
    const args = [
      claudePath,
      ...input.args,
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
      { toolCount: opts.tools.length, callbackPort },
      'Claude CLI: starting MCP tool bridge'
    );

    const proc = Bun.spawn(args, {
      cwd: tmpdir(), // Isolated dir — no CLAUDE.md, no auto-memory leakage
      stdout: 'pipe',
      stderr: 'pipe',
      env,
      ...(input.stdin !== undefined && { stdin: new TextEncoder().encode(input.stdin) }),
    });

    let killedByTimer = false;
    const timer = setTimeout(() => {
      killedByTimer = true;
      try {
        proc.kill();
      } catch {}
    }, timeout);

    const startTime = Date.now();

    const [rawStdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const stdout = input.stdin === undefined ? rawStdout : extractStreamJsonResult(rawStdout);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (exitCode !== 0) {
      const durationMs = Date.now() - startTime;
      const isTimeout = killedByTimer && (exitCode === 143 || exitCode === 137);
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

      throw createClaudeCliError(exitCode, detail, stdout, {
        timedOutAfterMs: isTimeout ? timeout : undefined,
      });
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

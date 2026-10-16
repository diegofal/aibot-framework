import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { TOOL_ABORTED_MESSAGE, isAbortError } from '../core/abort';
import type { KarmaService } from '../karma/service';
import type { Logger } from '../logger';
import { MEMORY_VIEWER_ARG, type MemoryViewer } from '../memory/viewer';
import { LIVING_DOC_DEFAULTS, livingDocRefusal } from '../productions/living-docs';
import {
  isScratchProductionPath,
  isUntrackedProductionPath,
  normalizeEntryPath,
} from '../productions/paths';
import { ProductionsService } from '../productions/service';
import type { RelayParty } from '../relay/types';
import { PERSONAL_TOOL_NAMES, personalToolsAllowedFor } from '../tools/personal';
import { tokensToChars, truncateToolResultContent } from '../tools/truncate-tool-result';
import type { Tool, ToolDefinition, ToolFailureKind, ToolResult } from '../tools/types';
import { clampToChainContextWindow } from './context-compaction';
import { type InlineApprovalStore, describeToolCall } from './inline-approval';
import type { LoopDetectionResult, ToolLoopDetector } from './tool-loop-detector';
import { type PermissionMode, getPermissionLevel } from './tool-permissions';
import type { BotContext } from './types';

/**
 * Record of a tool execution for logging/auditing purposes.
 */
export interface ToolExecutionRecord {
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  result: string;
  durationMs?: number;
  category?: string;
}

/**
 * Event payload for tool:start hook.
 * Emitted when a tool execution begins.
 */
/**
 * Who a tool event ran for, as stamped on `tool:start/end/error` (and bridged
 * to the activity stream). A cycle call has `cycleId`; a worker call has
 * `runId` / `taskId` / `dispatchCycleId` and never a `cycleId` (C17).
 */
export interface ToolEventAttribution {
  cycleId?: string;
  goalId?: string;
  runId?: string;
  taskId?: string;
  dispatchCycleId?: string;
}

export interface ToolStartEvent extends ToolEventAttribution {
  toolName: string;
  args: Record<string, unknown>;
  botId: string;
  chatId: number;
  timestamp: number;
}

/**
 * Event payload for tool:end hook.
 * Emitted when a tool execution completes (success or failure).
 */
export interface ToolEndEvent extends ToolEventAttribution {
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  result: string;
  durationMs: number;
  retryAttempts: number;
  botId: string;
  chatId: number;
  timestamp: number;
  /** Why a failed call failed, when the tool said so (see `ToolFailureKind`). */
  failureKind?: ToolFailureKind;
  /** Agent-loop cycle this call ran in (absent outside a cycle). */
  cycleId?: string;
  /** Goal the cycle served, when known at call time. */
  goalId?: string;
  /** Goal task the call worked on (the cycle's `serves_task`), when known. */
  taskId?: string;
}

/** The attribution ids of a tool event, for the activity-stream payload. */
function eventIds(e: ToolEventAttribution): ToolEventAttribution {
  return {
    ...(e.cycleId ? { cycleId: e.cycleId } : {}),
    ...(e.goalId ? { goalId: e.goalId } : {}),
    ...(e.runId ? { runId: e.runId } : {}),
    ...(e.taskId ? { taskId: e.taskId } : {}),
    ...(e.dispatchCycleId ? { dispatchCycleId: e.dispatchCycleId } : {}),
  };
}

const TARGET_MAX = 80;

/**
 * What a call touched, short enough for one feed line: a URL's host + path
 * (no query), else a file `path`, else a `command`. Pure.
 */
export function toolTarget(args: Record<string, unknown> | undefined): string | undefined {
  const pick = [args?.url, args?.path, args?.command].find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0
  );
  if (!pick) return undefined;
  let text = pick.trim();
  if (pick === args?.url) {
    try {
      const u = new URL(text);
      text = `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    } catch {
      // Not a URL: show it as given.
    }
  }
  return text.length > TARGET_MAX ? `${text.slice(0, TARGET_MAX - 1)}…` : text;
}

/**
 * Event payload for tool:error hook.
 * Emitted when a tool execution throws an error or fails validation.
 */
export interface ToolErrorEvent extends ToolEventAttribution {
  toolName: string;
  args: Record<string, unknown>;
  error: string;
  phase: 'lookup' | 'validation' | 'execution';
  botId: string;
  chatId: number;
  timestamp: number;
}

/**
 * Event payload for loop detection events (warning or blocked).
 */
export interface ToolLoopEvent {
  toolName: string;
  args: Record<string, unknown>;
  detector: string;
  level: 'warning' | 'critical';
  count: number;
  message: string;
  botId: string;
  chatId: number;
  timestamp: number;
}

/**
 * Observable events emitted by ToolExecutor.
 */
export interface ToolExecutorEvents {
  'tool:start': ToolStartEvent;
  'tool:end': ToolEndEvent;
  'tool:error': ToolErrorEvent;
  'tool:loop-warning': ToolLoopEvent;
  'tool:loop-blocked': ToolLoopEvent;
}

/**
 * Who a call ran for. A cycle executor carries `cycleId`; a future worker run
 * carries `runId` / `taskId` / `dispatchCycleId` and never a `cycleId` (C17).
 * Read at each call: the loop may resolve the goal mid-cycle.
 */
export interface ToolAttribution {
  cycleId?: string;
  goalId: string | null;
  runId?: string;
  taskId?: string;
  dispatchCycleId?: string;
  /** A curiosity explore cycle: its findings go to memory, not to production documents. */
  exploring?: boolean;
}

/**
 * The refusal of a call made after its run was cancelled: the tool never ran
 * (failureKind `aborted`). A call stopped mid-way returns
 * `TOOL_ABORTED_MESSAGE` instead, so readers (worker resume) can tell them apart.
 */
export function toolNotRunMessage(name: string): string {
  return `Tool "${name}" was not run: this run was cancelled. Stop and report.`;
}

/** A pre-execution refusal (`ToolExecutorOptions.refuse`): the tool never runs. */
export interface ToolRefusal {
  content: string;
  failureKind: ToolFailureKind;
}

/** Failures that are not the bot's doing: logged and emitted, never charged as karma. */
const UNCHARGED_FAILURES: ReadonlySet<ToolFailureKind> = new Set<ToolFailureKind>([
  'blocked',
  'exit-nonzero',
  'approval-pending',
  'aborted',
  'scope',
]);

/**
 * Options for configuring a ToolExecutor instance.
 */
export interface ToolExecutorOptions {
  /** Bot ID for _botId injection */
  botId: string;
  /** Chat ID for _chatId injection */
  chatId: number;
  /** User ID for _userId injection (per-user isolation) */
  userId?: string;
  /** Whose private memory the memory tools may read/write (memory/viewer.ts); null = shared only */
  memoryViewer?: MemoryViewer;
  /** Optional override of disabled tools (defaults to config lookup) */
  disabledTools?: Set<string>;
  /** Enable execution logging (for AgentLoop toolCallLog) */
  enableLogging?: boolean;
  /** Optional custom logger (defaults to ctx.logger) */
  logger?: Logger;
  /** Optional tool filter (for collaboration - excludes certain tools) */
  toolFilter?: (tool: Tool) => boolean;
  /** Optional tool list override (for collaboration) */
  tools?: Tool[];
  /** Optional karma service for quality gate penalties */
  karmaService?: KarmaService;
  /** Optional loop detector for agent-loop repetition protection */
  loopDetector?: ToolLoopDetector;
  /** Tenant root directory for path sandboxing (multi-tenant mode) */
  tenantRoot?: string;
  /** Permission mode for tool-level access control */
  permissionMode?: PermissionMode;
  /** Inline approval store for conversation-mode confirm interception */
  inlineApprovalStore?: InlineApprovalStore;
  /** Session key for inline approval store keying */
  sessionKey?: string;
  /**
   * Agent-loop cycle attribution, read at each call (the loop may resolve the
   * goal mid-cycle). Stamped on `tool:end`, productions and karma metadata;
   * the tool sees `_cycleId`.
   */
  attribution?: ToolAttribution;
  /**
   * Agent-loop permission enforcement (`bots[].agentLoop.enforceToolPermissions`).
   * Only read in `agent-loop` mode: off (default) a `confirm` tool runs as it
   * always did; on, it runs only with a recent approval of the same call and
   * otherwise files a request and returns `approval-pending`. Never awaits.
   */
  enforceToolPermissions?: boolean;
  /**
   * Cancellation of the run this executor serves (cycle timeout, Stop). Once
   * aborted every call is refused (`aborted`); the tool sees it as `_signal`.
   */
  signal?: AbortSignal;
  /** Working directory / write root override (default: the bot's workDir). */
  workDir?: string;
  /**
   * Pre-execution refusal (a task worker's write root): checked after the
   * disabled / permission checks, before the tool runs. A refusal is a normal
   * failed call — `tool:end` with its failureKind, so it reaches the audit.
   */
  refuse?: (name: string, args: Record<string, unknown>) => ToolRefusal | undefined;
  /**
   * Who is speaking in the conversation that triggered this call (relay
   * sender). Injected as `_requester`, always overriding model arguments;
   * absent (agent loop, collaboration) = the bot itself.
   */
  requester?: RelayParty;
}

/**
 * Result of a tool execution with metadata.
 */
export interface ToolExecutionResult extends ToolResult {
  toolName: string;
  args: Record<string, unknown>;
  durationMs: number;
  /**
   * Number of retry attempts made before final result.
   * 0 means first attempt succeeded.
   */
  retryAttempts?: number;
}

/**
 * Centralized tool execution engine.
 *
 * Encapsulates the common logic for:
 * - Tool lookup by name
 * - Disabled tool filtering
 * - Context injection (_chatId, _botId)
 * - Execution with error handling
 * - Optional logging and metrics
 *
 * Replaces duplicated logic in:
 * - AgentLoop.createAgentLoopExecutor()
 * - ToolRegistry.createExecutor()
 * - Collaboration.runVisibleTurn() inline executor
 * - Collaboration.collaborationStep() inline executor
 */
export class ToolExecutor extends EventEmitter {
  private disabledTools: Set<string>;
  private tools: Tool[];
  private logger: Logger;
  private executionLog: ToolExecutionRecord[] = [];
  private loopDetector: ToolLoopDetector | undefined;

  constructor(
    private ctx: BotContext,
    private options: ToolExecutorOptions
  ) {
    super();
    this.logger = options.logger ?? ctx.logger;
    this.tools = options.tools ?? ctx.tools;
    this.loopDetector = options.loopDetector;

    // Build disabled set: config + explicit override
    if (options.disabledTools) {
      this.disabledTools = options.disabledTools;
    } else {
      const botConfig = ctx.config.bots.find((b) => b.id === options.botId);
      this.disabledTools = new Set(botConfig?.disabledTools ?? []);
      // Safety net for executors built on ctx.tools (agent loop): the
      // personal-account tools exist only for the allowlisted bots.
      if (!personalToolsAllowedFor(ctx.config, options.botId)) {
        for (const n of PERSONAL_TOOL_NAMES) this.disabledTools.add(n);
      }
    }

    // Auto-bridge tool events to activity stream (if available)
    this.bridgeToActivityStream();

    // Bridge tool events to lifecycle hooks (if available)
    this.bridgeToHooks();
  }

  /**
   * Subscribe to own tool lifecycle events and publish to ctx.activityStream.
   * This ensures ALL ToolExecutor instances (agent-loop, conversation pipeline,
   * collaboration) automatically surface events in the activity stream.
   */
  private bridgeToActivityStream(): void {
    const stream = this.ctx.activityStream;
    if (!stream) return;

    this.on('tool:start', (e) =>
      stream.publish({
        type: 'tool:start',
        botId: e.botId,
        timestamp: e.timestamp,
        data: { toolName: e.toolName, args: e.args, ...eventIds(e) },
      })
    );
    this.on('tool:end', (e) => {
      stream.publish({
        type: 'tool:end',
        botId: e.botId,
        timestamp: e.timestamp,
        data: {
          toolName: e.toolName,
          success: e.success,
          durationMs: e.durationMs,
          result: e.result.slice(0, 300),
          ...eventIds(e),
          // A failure names its cause and what it touched, so the feed can say
          // "wiley.com blocked the bot" instead of "web_fetch failed".
          ...(e.success
            ? {}
            : {
                ...(e.failureKind ? { failureKind: e.failureKind } : {}),
                ...(toolTarget(e.args) ? { target: toolTarget(e.args) } : {}),
              }),
        },
      });

      // Record tool.called analytics for tenant bots
      const analyticsService = this.ctx.analyticsService;
      if (analyticsService) {
        const botConfig = this.ctx.config.bots.find((b) => b.id === e.botId);
        if (botConfig?.tenantId) {
          analyticsService.record({
            type: 'tool.called',
            tenantId: botConfig.tenantId,
            botId: e.botId,
            chatId: String(e.chatId),
            channelKind: 'unknown',
            data: {
              toolName: e.toolName,
              durationMs: e.durationMs,
              success: e.success,
            },
          });
        }
      }
    });
    this.on('tool:error', (e) =>
      stream.publish({
        type: 'tool:error',
        botId: e.botId,
        timestamp: e.timestamp,
        data: {
          toolName: e.toolName,
          error: e.error.slice(0, 300),
          phase: e.phase,
          ...eventIds(e),
        },
      })
    );
    this.on('tool:loop-warning', (e) =>
      stream.publish({
        type: 'tool:error',
        botId: e.botId,
        timestamp: e.timestamp,
        data: {
          toolName: e.toolName,
          error: `[loop-${e.level}] ${e.message}`.slice(0, 300),
          phase: 'loop-detection',
        },
      })
    );
    this.on('tool:loop-blocked', (e) =>
      stream.publish({
        type: 'tool:error',
        botId: e.botId,
        timestamp: e.timestamp,
        data: {
          toolName: e.toolName,
          error: `[loop-blocked] ${e.message}`.slice(0, 300),
          phase: 'loop-detection',
        },
      })
    );
  }

  /**
   * Bridge own tool lifecycle events to the central HookEmitter
   * so skills/extensions can listen via `hooks.onHook('before_tool_call', ...)`.
   */
  private bridgeToHooks(): void {
    const hooks = this.ctx.hooks;
    if (!hooks) return;

    this.on('tool:start', (e) =>
      hooks.emitHook('before_tool_call', {
        botId: e.botId,
        toolName: e.toolName,
        args: e.args,
        timestamp: e.timestamp,
      })
    );

    this.on('tool:end', (e) =>
      hooks.emitHook('after_tool_call', {
        botId: e.botId,
        toolName: e.toolName,
        args: e.args,
        success: e.success,
        durationMs: e.durationMs,
        timestamp: e.timestamp,
      })
    );
  }

  /**
   * Build a failure result, emit error + end events, and log the execution.
   * @param emitError - The error string to emit in the tool:error event (may differ from content).
   */
  /** `{ cycleId, goalId, taskId }` of the current agent-loop cycle, or `{}` outside one. */
  private attributionFields(): { cycleId?: string; goalId?: string; taskId?: string } {
    const a = this.options.attribution;
    if (!a) return {};
    return {
      ...(a.cycleId ? { cycleId: a.cycleId } : {}),
      ...(a.goalId ? { goalId: a.goalId } : {}),
      ...(a.taskId ? { taskId: a.taskId } : {}),
    };
  }

  /**
   * Ids stamped on tool events: the cycle's `{ cycleId, goalId }`, or a worker
   * run's `{ runId, taskId, dispatchCycleId, goalId }` (never a `cycleId`).
   */
  private eventAttribution(): ToolEventAttribution {
    const a = this.options.attribution;
    if (!a) return {};
    return {
      ...this.attributionFields(),
      ...(a.runId ? { runId: a.runId } : {}),
      ...(a.taskId ? { taskId: a.taskId } : {}),
      ...(a.dispatchCycleId ? { dispatchCycleId: a.dispatchCycleId } : {}),
    };
  }

  /** A failed tool result that is really the run's cancellation. */
  private stoppedByAbort(content: string): boolean {
    return this.options.signal?.aborted === true || content === TOOL_ABORTED_MESSAGE;
  }

  /**
   * Non-blocking confirm (C14). `null` = a recent approval of this very call
   * (same tool, same described call, `AskPermissionStore.hasRecentApproval`)
   * lets it run. Otherwise files the request — or reuses the pending one —
   * with the run's attribution and returns `approval-pending`. The request's
   * promise is never awaited; a later approval reaches the planner through
   * `consumeDecisionsForBot` and the retried call then passes here.
   */
  private requestApprovalWithoutWaiting(
    name: string,
    args: Record<string, unknown>,
    startMs: number
  ): ToolExecutionResult | null {
    const store = this.ctx.askPermissionStore;
    const { botId } = this.options;
    const resource = describeToolCall(name, args);
    if (!store) {
      return this.buildFailResult(
        name,
        args,
        startMs,
        `Tool "${name}" needs operator approval and no approval queue is available.`,
        'execution',
        0,
        undefined,
        'approval-pending'
      );
    }
    if (store.hasRecentApproval(botId, name, resource)) return null;

    const a = this.options.attribution;
    const { id, promise } = store.request(
      botId,
      name,
      resource,
      `Agent loop tool: ${name}(${Object.keys(args).join(', ')})`,
      'normal',
      {
        ...(a?.cycleId ? { cycleId: a.cycleId } : {}),
        ...(a?.goalId ? { goalId: a.goalId } : {}),
        ...(a?.runId ? { runId: a.runId } : {}),
      }
    );
    // Never awaited: a dispose/clear rejection must not surface as unhandled.
    promise.catch(() => {});
    this.logger.info(
      { tool: name, botId, permissionId: id },
      'Tool needs operator approval: request filed, not waiting'
    );
    return this.buildFailResult(
      name,
      args,
      startMs,
      `Approval requested (id ${id}) for ${name}: ${resource}. The operator decides on the dashboard; do not retry it now — continue with other work.`,
      'execution',
      0,
      undefined,
      'approval-pending'
    );
  }

  /**
   * The living-document refusal for an agent-loop cycle's write in productions
   * (`src/productions/living-docs.ts`); undefined outside a cycle, for worker
   * runs (their task folder is their scope), outside productions, or when
   * `productions.livingDocs.enabled` is false. Never throws.
   */
  private livingDocRefusalFor(
    name: string,
    args: Record<string, unknown>,
    botId: string
  ): string | undefined {
    if (name !== 'file_write' && name !== 'file_edit') return undefined;
    const a = this.options.attribution;
    const ps = this.ctx.productionsService;
    const cfg = { ...LIVING_DOC_DEFAULTS, ...(this.ctx.config.productions?.livingDocs ?? {}) };
    if (!a?.cycleId || a.runId || !ps || !cfg.enabled || typeof args.path !== 'string')
      return undefined;
    try {
      if (!ps.isEnabled(botId)) return undefined;
      const dir = resolve(ps.resolveDir(botId));
      const rel = relative(dir, resolve(args.path)).split(sep).join('/');
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
      return livingDocRefusal({
        tool: name,
        relPath: rel,
        args,
        exploring: a.exploring === true,
        goalId: a.goalId,
        entries: ps.getChangelog(botId, { limit: 5000 }),
        exists: (p) => existsSync(join(dir, p)),
        read: (p) => {
          try {
            return readFileSync(join(dir, p), 'utf-8');
          } catch {
            return null;
          }
        },
        maxChars: cfg.maxChars,
      });
    } catch (err) {
      this.logger.warn({ err, botId, tool: name }, 'Living documents: check failed, write allowed');
      return undefined;
    }
  }

  private buildFailResult(
    name: string,
    args: Record<string, unknown>,
    startMs: number,
    errorMsg: string,
    phase: 'lookup' | 'validation' | 'execution',
    retryAttempts = 0,
    emitError?: string,
    failureKind?: ToolFailureKind
  ): ToolExecutionResult {
    const { botId, chatId } = this.options;
    const durationMs = Date.now() - startMs;
    this.emit('tool:error', {
      toolName: name,
      args,
      error: emitError ?? errorMsg,
      phase,
      botId,
      chatId,
      timestamp: Date.now(),
      ...this.eventAttribution(),
    });

    // Karma per tool error (execution and validation phases) — delta from
    // config.karma.rewards.toolError (-1 default), deduped per tool+message.
    // A `blocked` failure is a third party refusing us (bot wall, 403, 429):
    // not the bot's doing, so it is logged and emitted but never charged.
    // `exit-nonzero` is a command that ran and returned a status the bot may
    // have wanted (grep with no match): not charged either.
    const chargeable = !failureKind || !UNCHARGED_FAILURES.has(failureKind);
    if (
      chargeable &&
      this.options.karmaService &&
      (phase === 'execution' || phase === 'validation')
    ) {
      const truncatedError = (emitError ?? errorMsg).slice(0, 120);
      const attribution = this.attributionFields();
      this.options.karmaService.recordOutcome(
        botId,
        'toolError',
        `Tool error: ${name} — ${truncatedError}`,
        attribution.cycleId ? attribution : undefined
      );
    }

    const result: ToolExecutionResult = {
      success: false,
      content: errorMsg,
      toolName: name,
      args,
      durationMs,
      retryAttempts,
      ...(failureKind ? { failureKind } : {}),
    };
    this.logExecution(name, args, false, errorMsg, durationMs);
    this.emit('tool:end', {
      toolName: name,
      args,
      success: false,
      result: errorMsg,
      durationMs,
      retryAttempts,
      botId,
      chatId,
      timestamp: Date.now(),
      ...this.eventAttribution(),
      ...(failureKind ? { failureKind } : {}),
    });
    return result;
  }

  /**
   * Execute a single tool call with full lifecycle management.
   * Returns the tool result with execution metadata.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const startMs = Date.now();
    const { botId, chatId } = this.options;

    // Emit start event
    this.emit('tool:start', {
      toolName: name,
      args,
      botId,
      chatId,
      timestamp: startMs,
      ...this.eventAttribution(),
    });

    // Cancelled run (cycle timeout, Stop): refuse before anything else runs.
    if (this.options.signal?.aborted) {
      return this.buildFailResult(
        name,
        args,
        startMs,
        toolNotRunMessage(name),
        'execution',
        0,
        undefined,
        'aborted'
      );
    }

    // Loop detection pre-check (before any execution)
    let loopWarningMessage: string | undefined;
    if (this.loopDetector) {
      const loopCheck = this.loopDetector.check(name, args);
      if (loopCheck.stuck) {
        const loopEvent: ToolLoopEvent = {
          toolName: name,
          args,
          detector: loopCheck.detector,
          level: loopCheck.level,
          count: loopCheck.count,
          message: loopCheck.message,
          botId,
          chatId,
          timestamp: Date.now(),
        };

        if (loopCheck.level === 'critical') {
          this.emit('tool:loop-blocked', loopEvent);
          this.logger.error(
            { tool: name, botId, detector: loopCheck.detector, count: loopCheck.count },
            `Loop detector blocked tool: ${loopCheck.message}`
          );
          return this.buildFailResult(
            name,
            args,
            startMs,
            `BLOCKED by loop detection (${loopCheck.detector}): ${loopCheck.message}`,
            'execution'
          );
        }

        // Warning level: emit event but continue execution
        this.emit('tool:loop-warning', loopEvent);
        this.logger.warn(
          { tool: name, botId, detector: loopCheck.detector, count: loopCheck.count },
          `Loop detector warning: ${loopCheck.message}`
        );
        loopWarningMessage = loopCheck.message;
      }
    }

    // Check if tool is disabled
    if (this.disabledTools.has(name)) {
      this.logger.warn({ tool: name, botId }, 'Disabled tool requested');
      return this.buildFailResult(
        name,
        args,
        startMs,
        `Tool "${name}" is not available`,
        'lookup',
        0,
        undefined,
        'disabled'
      );
    }

    // Caller's pre-execution refusal (a worker's write root): before any
    // approval is filed, and never charged (lookup phase).
    const refusal = this.options.refuse?.(name, args);
    if (refusal) {
      return this.buildFailResult(
        name,
        args,
        startMs,
        refusal.content,
        'lookup',
        0,
        undefined,
        refusal.failureKind
      );
    }

    // Permission matrix safety net: block tools that shouldn't be available in this mode
    if (this.options.permissionMode) {
      const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
      const level = getPermissionLevel(
        name,
        this.options.permissionMode,
        botConfig?.toolPermissions
      );
      if (level === 'blocked') {
        this.logger.warn(
          { tool: name, botId, mode: this.options.permissionMode },
          'Tool blocked by permission matrix'
        );
        return this.buildFailResult(
          name,
          args,
          startMs,
          `Tool "${name}" is not available in this context`,
          'lookup',
          0,
          undefined,
          'disabled'
        );
      }

      // Outside conversations a confirm tool never awaits the dashboard (C14):
      // it runs (flag off, the long-standing behaviour) or, with
      // enforceToolPermissions, runs only on a recent approval of this call.
      if (level === 'confirm' && this.options.permissionMode === 'agent-loop') {
        if (this.options.enforceToolPermissions) {
          const pending = this.requestApprovalWithoutWaiting(name, args, startMs);
          if (pending) return pending;
        }
        // Approved, or enforcement off — fall through to normal execution.
      } else if (level === 'confirm') {
        // Inline approval interception: confirm-level tools in conversation mode
        // Dashboard web path: use inline approval store (UI cards)
        if (this.options.inlineApprovalStore && this.options.sessionKey) {
          this.options.inlineApprovalStore.setPending(this.options.sessionKey, {
            toolName: name,
            args,
            createdAt: Date.now(),
            botId,
            sessionKey: this.options.sessionKey,
          });
          this.logger.info(
            { tool: name, botId, sessionKey: this.options.sessionKey },
            'Tool requires inline approval, pending user confirmation'
          );
          const description = describeToolCall(name, args);
          const durationMs = Date.now() - startMs;
          const syntheticContent = `⏳ This action requires user approval. I need to ask the user to confirm: ${description}. Do NOT retry this tool — wait for the user's next message.`;
          this.logExecution(name, args, true, syntheticContent, durationMs);
          this.emit('tool:end', {
            toolName: name,
            args,
            success: true,
            result: syntheticContent,
            durationMs,
            retryAttempts: 0,
            botId,
            chatId,
            timestamp: Date.now(),
            ...this.eventAttribution(),
          });
          return {
            toolName: name,
            args,
            durationMs,
            content: syntheticContent,
            success: true,
          };
        }
        // Channel path (Telegram, WhatsApp, Discord, etc.): use ask_permission → dashboard
        if (this.ctx.askPermissionStore) {
          const description = describeToolCall(name, args);
          const { promise } = this.ctx.askPermissionStore.request(
            botId,
            name,
            description,
            `Conversation tool: ${name}(${Object.keys(args).join(', ')})`,
            'high'
          );
          this.logger.info(
            { tool: name, botId },
            'Tool requires dashboard approval, waiting for permission decision'
          );
          // Block until dashboard user approves/denies
          const decision = await promise;
          if (decision !== 'approved') {
            return this.buildFailResult(
              name,
              args,
              startMs,
              `Tool "${name}" was denied by the operator`,
              'execution'
            );
          }
          // Approved — fall through to normal tool execution below
        }
      }
    }

    // Find the tool
    const tool = this.tools.find((t) => t.definition.function.name === name);
    if (!tool) {
      this.logger.warn({ tool: name }, 'Unknown tool requested');
      return this.buildFailResult(name, args, startMs, `Unknown tool: ${name}`, 'lookup');
    }

    // Apply optional tool filter (for collaboration)
    if (this.options.toolFilter && !this.options.toolFilter(tool)) {
      this.logger.warn({ tool: name, botId }, 'Tool filtered out by collaboration filter');
      return this.buildFailResult(
        name,
        args,
        startMs,
        `Tool "${name}" is not available in this context`,
        'lookup'
      );
    }

    // Get retry configuration
    const maxRetries = tool.definition.maxRetries ?? 0;

    // Execute with retry loop
    let lastError: string | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Inject context arguments + retry feedback on subsequent attempts
      const effectiveArgs: Record<string, unknown> = {
        ...args,
        _chatId: chatId,
        _botId: botId,
        ...(this.options.userId ? { _userId: this.options.userId } : {}),
        ...(this.options.memoryViewer !== undefined
          ? { [MEMORY_VIEWER_ARG]: this.options.memoryViewer }
          : {}),
        ...(this.options.tenantRoot ? { _tenantRoot: this.options.tenantRoot } : {}),
        ...(this.options.attribution?.cycleId
          ? { _cycleId: this.options.attribution.cycleId }
          : {}),
        ...(this.options.attribution?.goalId ? { _goalId: this.options.attribution.goalId } : {}),
        ...(this.options.attribution?.runId ? { _runId: this.options.attribution.runId } : {}),
        ...(this.options.attribution?.taskId ? { _taskId: this.options.attribution.taskId } : {}),
        ...(this.options.signal ? { _signal: this.options.signal } : {}),
        _requester: this.options.requester,
      };

      // Per-bot workDir: resolve file paths and exec cwd
      const botConfigForWorkDir = this.ctx.config.bots.find((b) => b.id === botId);
      const workDir =
        this.options.workDir ??
        botConfigForWorkDir?.workDir ??
        (this.ctx.config.productions?.baseDir
          ? `${this.ctx.config.productions.baseDir}/${botId}`
          : undefined);
      let originalPathForProductions: string | undefined;

      // Normalise path aliases (file_path, filepath, file → path) before workdir
      // resolution so the workdir prefix and productions logging both work
      // regardless of which alias the LLM used.
      if (
        ['file_read', 'file_write', 'file_edit'].includes(name) &&
        typeof effectiveArgs.path !== 'string'
      ) {
        for (const alias of ['file_path', 'filepath', 'file'] as const) {
          if (typeof effectiveArgs[alias] === 'string') {
            effectiveArgs.path = effectiveArgs[alias];
            break;
          }
        }
      }

      if (workDir) {
        mkdirSync(workDir, { recursive: true });
        effectiveArgs._workDir = workDir;

        if (
          ['file_read', 'file_write', 'file_edit'].includes(name) &&
          typeof effectiveArgs.path === 'string'
        ) {
          originalPathForProductions = effectiveArgs.path as string;

          // Strip redundant workDir prefix the LLM may include
          let filePath = effectiveArgs.path as string;
          const normWork = workDir.replace(/^\.\//, '');
          const normFile = filePath.replace(/^\.\//, '');
          if (normWork && normFile.startsWith(`${normWork}/`)) {
            filePath = normFile.slice(normWork.length + 1);
          }
          effectiveArgs.path = resolve(workDir, filePath);

          // Safety net: prevent file_write from creating subdirs (except archived/)
          if (name === 'file_write') {
            const resolved = effectiveArgs.path as string;
            const absWork = resolve(workDir);
            // Separators normalized to '/' before the comparisons below:
            // `relative()` returns backslashes on Windows, so the raw string
            // never contained '/' there and this safety net silently did
            // nothing — file_write could create subdirectories in workDir.
            const rel = relative(absWork, resolved).split(sep).join('/');
            if (rel.includes('/') && !rel.startsWith('archived/') && !rel.startsWith('..')) {
              const flat = join(absWork, basename(resolved));
              this.logger.warn(
                { tool: name, botId, original: resolved, flattened: flat },
                'Flattened nested path to root of workDir'
              );
              effectiveArgs.path = flat;
            }
          }
        }
        if (name === 'exec' && !effectiveArgs.workdir) {
          effectiveArgs.workdir = workDir;
        }
      }

      // Living documents: a cycle keeps one short document per goal and an
      // explore cycle writes none. Refused before the tool runs, uncharged.
      const docRefusal = this.livingDocRefusalFor(name, effectiveArgs, botId);
      if (docRefusal) {
        this.logger.info(
          { tool: name, botId, path: effectiveArgs.path },
          'Living documents: write refused'
        );
        return this.buildFailResult(
          name,
          args,
          startMs,
          docRefusal,
          'lookup',
          0,
          undefined,
          'scope'
        );
      }

      // Include previous error feedback for retry attempts
      if (attempt > 0 && lastError) {
        effectiveArgs._retryAttempt = attempt;
        effectiveArgs._previousError = lastError;
        this.logger.info(
          { tool: name, botId, attempt, maxRetries },
          'Retrying tool execution with error feedback'
        );
      }

      try {
        const toolResult = await tool.execute(effectiveArgs, this.logger);

        // Validate output against schema if defined
        const validatedResult = await this.validateOutput(tool, toolResult);

        if (validatedResult.success) {
          // Productions: log successful file operations with quality gate
          if (this.ctx.productionsService && ['file_write', 'file_edit'].includes(name)) {
            const ps = this.ctx.productionsService;
            if (ps.isEnabled(botId)) {
              const logPath =
                originalPathForProductions ?? (effectiveArgs.path as string | undefined);

              // Bookkeeping files and archived/** are never outputs (a logged
              // changelog.jsonl once got archived from Needs You); scratch
              // files (`_sim.ts`) are supporting work, not something to review.
              if (
                logPath &&
                !isScratchProductionPath(logPath) &&
                !isUntrackedProductionPath(
                  normalizeEntryPath(ps.resolveDir(botId), logPath.replace(/^\.\//, ''))
                )
              ) {
                // file_write uses `content`, file_edit uses `new_text`
                const content =
                  name === 'file_edit'
                    ? typeof args.new_text === 'string'
                      ? args.new_text
                      : ''
                    : typeof args.content === 'string'
                      ? args.content
                      : '';

                // Extract first heading for better descriptions
                const firstHeading = content ? content.match(/^#+ (.+)$/m)?.[1] : null;
                const description = firstHeading ?? `${name}: ${logPath}`;

                if (!content) {
                  // No content to assess (e.g. missing args) — skip quality gate entirely
                  ps.logProduction({
                    timestamp: new Date().toISOString(),
                    botId,
                    tool: name,
                    path: logPath,
                    action: name === 'file_write' ? (args.append ? 'edit' : 'create') : 'edit',
                    description,
                    size: 0,
                    trackOnly: ps.isTrackOnly(botId),
                    ...this.attributionFields(),
                  });
                } else {
                  const quality = ProductionsService.assessContentQuality(content);

                  if (quality.isTemplate) {
                    this.logger.debug(
                      { botId, path: logPath, ratio: quality.ratio },
                      'Quality gate: skipping template production'
                    );
                    if (this.options.karmaService) {
                      this.options.karmaService.addEvent(
                        botId,
                        -3,
                        `Empty template detected in "${logPath}"`,
                        'production'
                      );
                    }
                  } else {
                    // Auto-number new files (non-append file_write only)
                    const finalPath =
                      name === 'file_write' && !args.append
                        ? ps.renumberFile(botId, logPath)
                        : logPath;
                    // The rename happens after the tool returned: without this
                    // note the bot reads or runs the name it wrote, which is gone.
                    if (finalPath !== logPath) {
                      validatedResult.content = `${validatedResult.content}\n\n[Saved as ${finalPath} — use this path from now on]`;
                    }

                    // Inject frontmatter for new .md files (non-append file_write)
                    if (name === 'file_write' && !args.append && finalPath.endsWith('.md')) {
                      try {
                        const absFilePath = join(ps.resolveDir(botId), finalPath);
                        if (existsSync(absFilePath)) {
                          const fileContent = readFileSync(absFilePath, 'utf-8');
                          const withFrontmatter = ProductionsService.injectFrontmatter(
                            fileContent,
                            absFilePath,
                            new Date().toISOString()
                          );
                          if (withFrontmatter !== fileContent) {
                            writeFileSync(absFilePath, withFrontmatter, 'utf-8');
                          }
                        }
                      } catch {
                        /* skip frontmatter injection errors */
                      }
                    }

                    ps.logProduction({
                      timestamp: new Date().toISOString(),
                      botId,
                      tool: name,
                      path: finalPath,
                      action: name === 'file_write' ? (args.append ? 'edit' : 'create') : 'edit',
                      description,
                      size: content.length,
                      trackOnly: ps.isTrackOnly(botId),
                      ...this.attributionFields(),
                    });
                  }
                }
              }
            }
          }

          // ─── GAP-TR1: Truncate oversized tool results ───
          // Prevents single tool results from consuming disproportionate context window.
          // Smart tail preservation keeps error messages visible even when output is huge.
          if (validatedResult.content && typeof validatedResult.content === 'string') {
            const compaction = this.ctx.config.conversation?.compaction;
            const configuredTokens = compaction?.contextWindows?.ollamaTokens;
            // Budget against the smallest window the prompt could be replayed
            // into on failover, not the configured ceiling.
            const contextTokens = configuredTokens
              ? clampToChainContextWindow(
                  configuredTokens,
                  this.ctx.config.ollama?.models,
                  compaction?.modelContextWindows
                ).tokens
              : undefined;
            const contextChars = contextTokens ? tokensToChars(contextTokens) : undefined;

            const truncation = truncateToolResultContent(validatedResult.content, contextChars);
            if (truncation.wasTruncated) {
              validatedResult.content = truncation.content;
              this.logger.debug(
                `[ToolExecutor] Result truncated: ${truncation.originalLength.toLocaleString()} → ${truncation.content.length.toLocaleString()} chars (strategy: ${truncation.strategy})`
              );
            }
          }
          // Record in loop detector
          if (this.loopDetector) {
            this.loopDetector.recordCall(name, args);
            this.loopDetector.recordOutcome(name, args, validatedResult.content);
          }

          // Inject loop warning into result content so LLM sees it
          const finalContent = loopWarningMessage
            ? `${validatedResult.content}\n\n[LOOP WARNING: ${loopWarningMessage}]`
            : validatedResult.content;

          // Success! Return result with retry count
          const durationMs = Date.now() - startMs;
          const result: ToolExecutionResult = {
            ...validatedResult,
            content: finalContent,
            toolName: name,
            args,
            durationMs,
            retryAttempts: attempt,
          };
          this.logExecution(name, args, true, finalContent, durationMs);
          this.emit('tool:end', {
            toolName: name,
            args,
            success: true,
            result: finalContent,
            durationMs,
            retryAttempts: attempt,
            botId,
            chatId,
            timestamp: Date.now(),
            ...this.eventAttribution(),
          });
          return result;
        }

        // Tool error (not validation) — pass through without retry
        if (!toolResult.success) {
          // Record errors in loop detector too
          if (this.loopDetector) {
            this.loopDetector.recordCall(name, args);
            this.loopDetector.recordOutcome(name, args, validatedResult.content);
          }
          return this.buildFailResult(
            name,
            args,
            startMs,
            validatedResult.content,
            'execution',
            attempt,
            undefined,
            this.stoppedByAbort(toolResult.content) ? 'aborted' : toolResult.failureKind
          );
        }

        // Validation failure — retryable if we have retries left
        lastError = validatedResult.content;
        this.emit('tool:error', {
          toolName: name,
          args,
          error: lastError,
          phase: 'validation',
          botId,
          chatId,
          timestamp: Date.now(),
          ...this.eventAttribution(),
        });
        if (attempt < maxRetries) {
          this.logger.warn(
            { tool: name, botId, attempt, error: lastError },
            'Tool validation failed, will retry'
          );
          await this.delay(this.calculateBackoff(attempt));
          continue;
        }

        // No retries left — return validation error
        return this.buildFailResult(
          name,
          args,
          startMs,
          `Validation failed after ${attempt + 1} attempt(s): ${lastError}`,
          'validation',
          attempt
        );
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // A cancelled run: no retry, no karma — the tool did not break.
        if (isAbortError(err) || this.options.signal?.aborted) {
          this.logger.info({ tool: name, botId }, 'Tool stopped: run cancelled');
          return this.buildFailResult(
            name,
            args,
            startMs,
            TOOL_ABORTED_MESSAGE,
            'execution',
            attempt,
            lastError ?? undefined,
            'aborted'
          );
        }
        this.logger.error({ tool: name, botId, attempt, error: err }, 'Tool execution error');

        // Record thrown errors in loop detector
        if (this.loopDetector) {
          this.loopDetector.recordCall(name, args);
          this.loopDetector.recordOutcome(name, args, `error:${lastError}`);
        }

        // Retries left — emit error and continue
        if (attempt < maxRetries) {
          this.emit('tool:error', {
            toolName: name,
            args,
            error: lastError,
            phase: 'execution',
            botId,
            chatId,
            timestamp: Date.now(),
            ...this.eventAttribution(),
          });
          await this.delay(this.calculateBackoff(attempt));
          continue;
        }

        // No retries left — return final error
        return this.buildFailResult(
          name,
          args,
          startMs,
          `Tool execution failed after ${attempt + 1} attempt(s): ${lastError}`,
          'execution',
          attempt,
          lastError ?? undefined
        );
      }
    }

    // Should never reach here, but TypeScript requires a return
    return this.buildFailResult(
      name,
      args,
      startMs,
      'Unexpected execution path',
      'execution',
      maxRetries
    );
  }

  /**
   * Calculate exponential backoff delay in ms.
   * Attempt 0: 0ms (immediate)
   * Attempt 1: 1000ms
   * Attempt 2: 2000ms
   * Attempt 3: 4000ms
   * Max: 10000ms
   */
  private calculateBackoff(attempt: number): number {
    if (attempt === 0) return 0;
    return Math.min(1000 * 2 ** (attempt - 1), 10000);
  }

  /**
   * Simple delay helper for async backoff.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Extended result type with validation metadata.
   */
  private validateOutput(
    tool: Tool,
    result: ToolResult
  ): ToolResult & { _validationError?: boolean } {
    const schema = tool.definition.outputSchema;
    if (!schema) {
      return result;
    }

    // Only validate successful outputs - errors pass through without retry
    if (!result.success) {
      return result;
    }

    try {
      // Parse content as JSON if it's a string that looks like JSON
      let data: unknown;
      if (typeof result.content === 'string') {
        const trimmed = result.content.trim();
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))
        ) {
          try {
            data = JSON.parse(trimmed);
          } catch {
            // If parsing fails, treat as raw string
            data = result.content;
          }
        } else {
          data = result.content;
        }
      } else {
        data = result.content;
      }

      // Validate against schema
      schema.parse(data);
      return result;
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        const issues = validationError.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
        const errorMsg = `Output validation failed:\n${issues.join('\n')}`;

        this.logger.warn(
          { tool: tool.definition.function.name, issues: validationError.errors },
          'Tool output validation failed'
        );

        return {
          success: false,
          content: errorMsg,
        };
      }

      // Re-throw unexpected errors
      throw validationError;
    }
  }

  /**
   * Create the callback expected by LLMClient.chat().
   * This is the standard interface for tool execution in conversations.
   */
  createCallback(): (name: string, args: Record<string, unknown>) => Promise<ToolResult> {
    return async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const result = await this.execute(name, args);
      // Return only the ToolResult part (without metadata)
      return {
        success: result.success,
        content: result.content,
      };
    };
  }

  /**
   * Get execution history (for AgentLoop logging).
   */
  getExecutionLog(): ToolExecutionRecord[] {
    return [...this.executionLog];
  }

  /**
   * Extract file paths created/edited during execution (file_write, file_edit).
   * Returns paths relative to workDir with optional sizes.
   */
  getFileOperations(): { path: string; size?: number }[] {
    const workDir = this.resolveWorkDir();
    return this.executionLog
      .filter((r) => r.success && ['file_write', 'file_edit'].includes(r.name))
      .map((r) => {
        const rawPath = r.args.path as string;
        if (!rawPath) return null;
        try {
          const absPath = workDir ? resolve(workDir, rawPath) : rawPath;
          const size = existsSync(absPath) ? statSync(absPath).size : undefined;
          return { path: rawPath, size };
        } catch {
          return { path: rawPath };
        }
      })
      .filter((f): f is { path: string; size?: number } => f !== null);
  }

  private resolveWorkDir(): string | undefined {
    const botConfig = this.ctx.config.bots.find((b) => b.id === this.options.botId);
    return (
      botConfig?.workDir ??
      (this.ctx.config.productions?.baseDir
        ? `${this.ctx.config.productions.baseDir}/${this.options.botId}`
        : undefined)
    );
  }

  /**
   * Clear execution history.
   */
  clearExecutionLog(): void {
    this.executionLog = [];
  }

  private logExecution(
    name: string,
    args: Record<string, unknown>,
    success: boolean,
    result: string,
    durationMs: number
  ): void {
    if (!this.options.enableLogging) return;

    // Truncate result for logging (same as AgentLoop did)
    const truncatedResult = result.length > 2000 ? result.slice(0, 2000) : result;

    this.executionLog.push({
      name,
      args,
      success,
      result: truncatedResult,
      durationMs,
    });
  }

  /**
   * Get tool definitions for the available tools (respecting filters).
   * Useful for building tool lists for LLM calls.
   */
  getDefinitions(): ToolDefinition[] {
    const filtered = this.tools.filter((t) => {
      if (this.disabledTools.has(t.definition.function.name)) return false;
      if (this.options.toolFilter) return this.options.toolFilter(t);
      return true;
    });
    return filtered.map((t) => t.definition);
  }

  /**
   * Check if a tool is available (not disabled and passes filter).
   */
  isToolAvailable(name: string): boolean {
    if (this.disabledTools.has(name)) return false;
    const tool = this.tools.find((t) => t.definition.function.name === name);
    if (!tool) return false;
    if (this.options.toolFilter) return this.options.toolFilter(tool);
    return true;
  }
}

/**
 * Factory function to create a ToolExecutor with common configurations.
 */
export function createToolExecutor(ctx: BotContext, options: ToolExecutorOptions): ToolExecutor {
  return new ToolExecutor(ctx, options);
}

/**
 * Create a collaboration-safe tool executor.
 * Excludes delegate_to_bot and collaborate tools.
 */
export function createCollaborationToolExecutor(
  ctx: BotContext,
  botId: string,
  chatId: number,
  options?: Omit<ToolExecutorOptions, 'botId' | 'chatId'>
): ToolExecutor {
  const excluded = new Set(['collaborate', 'delegate_to_bot']);
  return new ToolExecutor(ctx, {
    botId,
    chatId,
    ...options,
    toolFilter: (tool: Tool) => !excluded.has(tool.definition.function.name),
  });
}

/**
 * One executor turn: the system + user prompt, the tool definitions offered,
 * a `ToolExecutor` (agent-loop permission mode, attribution, abort signal),
 * the tool-audit subscription, the timeout (which aborts), the `llm:*`
 * activity events, the query log and the shared backend circuit breaker.
 *
 * Extracted from the cycle executor in `agent-loop.ts` so a future task
 * worker step (plan C11) runs the same turn with its own prompt, tool set,
 * attribution (`{ runId, taskId, goalId, dispatchCycleId }`) and write root.
 * Never throws: the caller decides what an error means for its run.
 */
import type { BotConfig } from '../config';
import type { LLMClient, TokenUsage } from '../core/llm-client';
import type { KarmaService } from '../karma/service';
import type { Logger } from '../logger';
import type { ChatMessage } from '../ollama';
import type { Tool, ToolDefinition } from '../tools/types';
import type { BackendCircuitBreaker } from './agent-retry-engine';
import { askedQuestionId } from './ask-human-store';
import type { LlmQueryEntry } from './llm-query-log';
import type { SystemPromptBuilder } from './system-prompt-builder';
import { toolEndToAuditEntry } from './tool-audit-log';
import {
  type ToolAttribution,
  type ToolEndEvent,
  type ToolExecutionRecord,
  ToolExecutor,
} from './tool-executor';
import type { ToolLoopDetector } from './tool-loop-detector';
import type { ToolCategory, ToolRegistry } from './tool-registry';
import type { BotContext } from './types';

export interface ExecutorTurnTools {
  /** The bot's tools for this mode, already permission- and disabled-filtered. */
  definitions: ToolDefinition[];
  /** Never offered; the executor refuses them too. */
  disabled: Set<string>;
  /** Narrow by planner-picked categories (blocked tools still filtered for agent-loop). */
  preSelect?: {
    categories: ToolCategory[];
    registry: Pick<ToolRegistry, 'getDefinitionsByCategories'>;
  };
  /** Tools only this turn has (e.g. worker report tools): offered and executable. */
  extra?: Tool[];
  /** Names this turn must not use: dropped from definitions and refused at execution. */
  denied?: string[];
}

export interface ExecutorTurnInput {
  ctx: BotContext;
  botId: string;
  botConfig: BotConfig;
  llmClient: LLMClient;
  model: string;
  /** Query-log / `llm:*` caller. Default `executor`. */
  caller?: LlmQueryEntry['caller'];
  /** `system` absent = the autonomous system prompt from `systemPromptBuilder`. */
  prompt: { system?: string; user: string };
  systemPromptBuilder?: Pick<SystemPromptBuilder, 'build'>;
  tools: ExecutorTurnTools;
  /** Shared by reference: the caller may resolve the goal mid-turn. */
  attribution?: ToolAttribution;
  chatId?: number;
  temperature: number;
  maxToolRounds: number;
  /** Fires the turn's abort and fails it with `${timeoutLabel} timed out after …`. */
  timeoutMs: number;
  timeoutLabel?: string;
  /** Cancellation from the run (cycle `maxDurationMs`, Stop, shutdown). */
  signal?: AbortSignal;
  /** Working directory / write root for file and exec tools (default: the bot's). */
  workDir?: string;
  tenantRoot?: string;
  loopDetector?: ToolLoopDetector;
  karmaService?: KarmaService;
  /** `bots[].agentLoop.enforceToolPermissions`: non-blocking confirm. */
  enforceToolPermissions?: boolean;
  /** Fleet-wide breaker; fed with the LLM outcome (never with our own timeout/abort). */
  breaker?: BackendCircuitBreaker;
  /** Query-log sink. Default: `ctx.llmQueryLog` stamped with the attribution's cycle/goal. */
  queryLog?: (entry: LlmQueryEntry) => void;
  onToolEnd?: (event: ToolEndEvent) => void;
  /** Called once the offered tools are known, right before the LLM call. */
  onStart?: (info: { toolCount: number }) => void;
  /** Attach the turn's file writes to a pending ask_human inbox message. Default true. */
  autoAttachFiles?: boolean;
  logger: Logger;
}

export type ExecutorTurnStopReason =
  | 'completed'
  | 'loop-break'
  | 'exhausted'
  | 'error'
  | 'timeout'
  | 'aborted';

export interface ExecutorTurnResult {
  ok: boolean;
  stopReason: ExecutorTurnStopReason;
  text: string;
  usage?: TokenUsage;
  /** Set when `ok` is false. */
  error?: unknown;
  /** Execution log of every tool call in the turn (also on failure). */
  toolCalls: ToolExecutionRecord[];
  /** Definitions offered to the model. */
  toolDefinitions: ToolDefinition[];
  executor: ToolExecutor;
  loop: { warnings: number; blocks: number };
  durationMs: number;
}

class TurnTimeoutError extends Error {}
/** Named like every other abort (core/abort.ts): the retry engine never retries it. */
class TurnAbortedError extends Error {
  override name = 'AbortError';
}

/** The definitions a turn offers: pre-selection, then disabled and denied names, then extras. */
export function resolveTurnDefinitions(
  botId: string,
  tools: ExecutorTurnTools,
  logger?: Logger
): ToolDefinition[] {
  const denied = new Set(tools.denied ?? []);
  let defs = tools.definitions;
  if (tools.preSelect && tools.preSelect.categories.length > 0) {
    const categoryFiltered = tools.preSelect.registry.getDefinitionsByCategories(
      tools.preSelect.categories,
      botId,
      'agent-loop'
    );
    defs = categoryFiltered.filter((d) => !tools.disabled.has(d.function.name));
    logger?.info(
      {
        botId,
        selectedCategories: tools.preSelect.categories,
        fullToolCount: tools.definitions.length,
        filteredToolCount: defs.length,
      },
      'Agent loop: tool pre-selection active'
    );
  }
  const offered = defs.filter((d) => !denied.has(d.function.name));
  for (const t of tools.extra ?? []) {
    if (!denied.has(t.definition.function.name)) offered.push(t.definition);
  }
  return offered;
}

export async function runExecutorTurn(input: ExecutorTurnInput): Promise<ExecutorTurnResult> {
  const { ctx, botId, botConfig, llmClient, logger } = input;
  const caller = input.caller ?? 'executor';
  const label = input.timeoutLabel ?? 'Executor phase';

  const system =
    input.prompt.system ??
    input.systemPromptBuilder?.build({
      mode: 'autonomous',
      memoryViewer: null,
      botId,
      botConfig,
      isGroup: false,
    }) ??
    '';
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: input.prompt.user },
  ];

  // One controller per turn, linked to the run's signal: our timeout aborts
  // it, and so does the run being cancelled.
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) controller.abort(input.signal.reason);
  else input.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const disabled = new Set([...input.tools.disabled, ...(input.tools.denied ?? [])]);
  const extra = input.tools.extra ?? [];
  const executor = new ToolExecutor(ctx, {
    memoryViewer: null,
    botId,
    chatId: input.chatId ?? 0,
    disabledTools: disabled,
    enableLogging: true,
    karmaService: input.karmaService,
    loopDetector: input.loopDetector,
    tenantRoot: input.tenantRoot,
    attribution: input.attribution,
    permissionMode: 'agent-loop',
    enforceToolPermissions: input.enforceToolPermissions === true,
    signal: controller.signal,
    ...(input.workDir ? { workDir: input.workDir } : {}),
    ...(extra.length > 0 ? { tools: [...ctx.tools, ...extra] } : {}),
  });

  const loop = { warnings: 0, blocks: 0 };
  executor.on('tool:loop-warning', () => {
    loop.warnings++;
  });
  executor.on('tool:loop-blocked', () => {
    loop.blocks++;
  });
  if (ctx.toolAuditLog) {
    const auditLog = ctx.toolAuditLog;
    executor.on('tool:end', (event) => {
      auditLog.append(toolEndToAuditEntry(event));
    });
  }
  if (input.onToolEnd) executor.on('tool:end', input.onToolEnd);

  const toolDefinitions = resolveTurnDefinitions(botId, input.tools, logger);
  input.onStart?.({ toolCount: toolDefinitions.length });

  const appendQuery =
    input.queryLog ??
    ((entry: LlmQueryEntry) => {
      const a = input.attribution;
      ctx.llmQueryLog?.append({
        ...entry,
        ...(a?.cycleId ? { cycleId: a.cycleId } : {}),
        ...(a?.goalId ? { goalId: a.goalId } : {}),
      });
    });

  const startMs = Date.now();
  ctx.activityStream?.publish({
    type: 'llm:start',
    botId,
    timestamp: startMs,
    data: { caller, backend: llmClient.backend, toolCount: toolDefinitions.length },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopListening: (() => void) | undefined;
  try {
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new TurnTimeoutError(
          `${label} timed out after ${input.timeoutMs}ms (session timeout guard)`
        );
        reject(err);
        controller.abort(err);
      }, input.timeoutMs);
      const onAbort = () => {
        const reason = controller.signal.reason;
        if (reason instanceof TurnTimeoutError) return; // the timer already rejected
        reject(new TurnAbortedError(reason instanceof Error ? reason.message : `${label} aborted`));
      };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
      stopListening = () => controller.signal.removeEventListener('abort', onAbort);
    });
    const result = await Promise.race([
      llmClient.chat(messages, {
        model: input.model,
        temperature: input.temperature,
        tools: toolDefinitions,
        toolExecutor: executor.createCallback(),
        maxToolRounds: input.maxToolRounds,
        signal: controller.signal,
      }),
      guard,
    ]);
    const usage = result.usage;
    ctx.activityStream?.publish({
      type: 'llm:end',
      botId,
      timestamp: Date.now(),
      data: {
        caller,
        backend: llmClient.backend,
        durationMs: Date.now() - startMs,
        model: usage?.model,
        tokensIn: usage?.promptTokens,
        tokensOut: usage?.completionTokens,
      },
    });
    appendQuery({
      timestamp: new Date().toISOString(),
      botId,
      caller,
      model: usage?.model ?? input.model,
      backend: llmClient.backend,
      temperature: input.temperature,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      totalTokens: usage?.totalTokens,
      toolCount: toolDefinitions.length,
      durationMs: Date.now() - startMs,
      success: true,
    });
    input.breaker?.recordSuccess(llmClient.backend);

    const toolCalls = [...executor.getExecutionLog()];
    if (input.autoAttachFiles !== false) autoAttachFiles(ctx, botId, executor, toolCalls, logger);
    return {
      ok: true,
      stopReason: result.stopReason ?? 'completed',
      text: result.text,
      usage,
      toolCalls,
      toolDefinitions,
      executor,
      loop,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.activityStream?.publish({
      type: 'llm:error',
      botId,
      timestamp: Date.now(),
      data: {
        caller,
        backend: llmClient.backend,
        durationMs: Date.now() - startMs,
        error: message,
      },
    });
    appendQuery({
      timestamp: new Date().toISOString(),
      botId,
      caller,
      model: input.model,
      backend: llmClient.backend,
      temperature: input.temperature,
      toolCount: toolDefinitions.length,
      durationMs: Date.now() - startMs,
      success: false,
      error: message,
    });
    const stopReason: ExecutorTurnStopReason =
      err instanceof TurnTimeoutError
        ? 'timeout'
        : err instanceof TurnAbortedError
          ? 'aborted'
          : 'error';
    // Our own timeout or a cancelled run says nothing about the backend.
    if (stopReason === 'error') input.breaker?.recordFailure(llmClient.backend, err);
    // An LLM error leaves no reason to keep tools running in the background.
    if (!controller.signal.aborted) controller.abort(err);
    return {
      ok: false,
      stopReason,
      text: '',
      error: err,
      toolCalls: [...executor.getExecutionLog()],
      toolDefinitions,
      executor,
      loop,
      durationMs: Date.now() - startMs,
    };
  } finally {
    if (timer) clearTimeout(timer);
    stopListening?.();
    input.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * After a turn, if ask_human was called, retroactively attach the turn's
 * file_write/file_edit outputs to the inbox conversation message.
 */
export function autoAttachFiles(
  ctx: BotContext,
  botId: string,
  executor: Pick<ToolExecutor, 'getFileOperations'>,
  toolCallLog: ToolExecutionRecord[],
  logger: Logger
): void {
  // The question this turn registered, by the id its tool result announces.
  // Never "the last pending": a worker run (or the cycle) may have asked since.
  let questionId: string | null = null;
  for (const t of toolCallLog) {
    if (t.name !== 'ask_human' || !t.success) continue;
    questionId = askedQuestionId(t.result) ?? questionId;
  }
  if (!questionId) return;

  const fileOps = executor.getFileOperations();
  if (fileOps.length === 0) return;

  const conversationsService = ctx.conversationsService;
  if (!conversationsService) return;

  // The store maps question → conversation while pending; the thread itself
  // carries the question id once it was answered.
  const id = questionId;
  const conversationId =
    ctx.askHumanStore.getPendingForBot(botId).find((q) => q.id === id)?.conversationId ??
    conversationsService.findByQuestionId(botId, id)?.id;
  if (!conversationId) return;

  const messages = conversationsService.getMessages(botId, conversationId);
  const botMsg = messages.find((m) => m.role === 'bot');
  if (!botMsg) return;

  const existingPaths = new Set((botMsg.files ?? []).map((f) => f.path));
  const newFiles = fileOps.filter((f) => !existingPaths.has(f.path));
  if (newFiles.length === 0) return;

  const attached = conversationsService.attachFiles(botId, conversationId, botMsg.id, newFiles);
  if (attached) {
    logger.info(
      { botId, conversationId, fileCount: newFiles.length },
      'Agent loop: auto-attached files to ask_human inbox message'
    );
  }
}

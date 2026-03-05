import type { CronService } from '../cron';
import type { Logger } from '../logger';
import type { Tool, ToolResult } from '../tools/types';
import type { ExternalToolDef } from './external-skill-loader';
import type { ToolExecuteFn } from './types';

/**
 * TSC Logger interface (single-arg string methods).
 */
interface TscLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * TSC SkillContext passed to tool handlers.
 * Includes `data` (DataStore-compatible wrapper over state) so internal skills
 * that use ctx.data.get/set work correctly through the adapter.
 */
interface TscSkillContext {
  state: Map<string, unknown>;
  config: Record<string, unknown>;
  logger: TscLogger;
  data: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): boolean;
    has(key: string): boolean;
  };
  cron: {
    add(opts: Record<string, unknown>): Promise<void>;
    remove(opts: Record<string, unknown>): Promise<void>;
  };
  tools: {
    execute: ToolExecuteFn;
  };
}

type TscToolHandler = (args: Record<string, unknown>, context: TscSkillContext) => Promise<unknown>;

/**
 * Optional cron dependencies for wiring real CronService into the adapter.
 */
export interface ExternalToolCronDeps {
  cronService: CronService;
}

/**
 * Wrap a pino Logger to match the TSC single-arg Logger interface.
 */
function wrapLogger(pinoLogger: Logger, skillId: string): TscLogger {
  const child = pinoLogger.child({ externalSkill: skillId });
  return {
    debug: (msg: string) => child.debug(msg),
    info: (msg: string) => child.info(msg),
    warn: (msg: string) => child.warn(msg),
    error: (msg: string) => child.error(msg),
  };
}

/**
 * Serialize a tool handler's return value to a string for ToolResult.content.
 */
function serializeResult(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/**
 * Build the cron adapter object for TscSkillContext.
 * When cronDeps is provided, delegates to the real CronService.
 * Otherwise falls back to a no-op that logs a warning.
 */
function buildCronAdapter(
  tscLogger: TscLogger,
  cronDeps: ExternalToolCronDeps | undefined,
  getArgs: () => Record<string, unknown>
): TscSkillContext['cron'] {
  if (!cronDeps) {
    return {
      add: async (opts: Record<string, unknown>) => {
        tscLogger.warn(
          `Cron add called from external tool adapter (job: ${opts.name ?? 'unknown'}) — no CronService available`
        );
      },
      remove: async (opts: Record<string, unknown>) => {
        tscLogger.warn(
          `Cron remove called from external tool adapter (job: ${opts.jobId ?? 'unknown'}) — no CronService available`
        );
      },
    };
  }

  const { cronService } = cronDeps;

  return {
    add: async (opts: Record<string, unknown>) => {
      const args = getArgs();
      const chatId = args._chatId as number | undefined;
      const botId = args._botId as string | undefined;
      if (!chatId || !botId) {
        tscLogger.warn('Cron add: missing _chatId or _botId — cannot schedule job');
        return;
      }

      const schedule = opts.schedule as
        | { kind: string; at?: string; everyMs?: number; expr?: string; tz?: string }
        | undefined;
      if (!schedule || !schedule.kind) {
        tscLogger.warn('Cron add: missing schedule — cannot schedule job');
        return;
      }

      let cronSchedule:
        | { kind: 'at'; at: string }
        | { kind: 'every'; everyMs: number }
        | { kind: 'cron'; expr: string; tz?: string };

      if (schedule.kind === 'at' && schedule.at) {
        cronSchedule = { kind: 'at', at: schedule.at };
      } else if (schedule.kind === 'every' && schedule.everyMs) {
        cronSchedule = { kind: 'every', everyMs: schedule.everyMs };
      } else if (schedule.kind === 'cron' && schedule.expr) {
        cronSchedule = { kind: 'cron', expr: schedule.expr, tz: schedule.tz };
      } else {
        tscLogger.warn(`Cron add: unsupported schedule kind "${schedule.kind}"`);
        return;
      }

      const text = (opts.text as string) ?? '';
      const name = (opts.name as string) ?? 'External skill job';
      const deleteAfterRun =
        typeof opts.deleteAfterRun === 'boolean' ? opts.deleteAfterRun : undefined;

      const job = await cronService.add({
        name,
        enabled: true,
        deleteAfterRun,
        schedule: cronSchedule,
        payload: { kind: 'message', text, chatId, botId },
      });

      tscLogger.info(`Cron job created: ${job.id} (${job.name})`);
    },

    remove: async (opts: Record<string, unknown>) => {
      const jobId = (opts.jobId ?? opts.id) as string | undefined;
      if (!jobId) {
        tscLogger.warn('Cron remove: missing jobId');
        return;
      }

      // jobId from skills is the job name, but CronService.remove() takes the UUID id.
      // Look up the job by name first, then remove by id.
      const jobs = await cronService.list({ includeDisabled: true });
      const match = jobs.find((j) => j.id === jobId || j.name === jobId);
      if (match) {
        await cronService.remove(match.id);
        tscLogger.info(`Cron job removed: ${match.id} (${match.name})`);
      } else {
        tscLogger.warn(`Cron remove: job "${jobId}" not found`);
      }
    },
  };
}

/**
 * Adapt a TSC tool handler + manifest tool def into the framework's Tool interface.
 *
 * - Namespaces the tool name: `${skillId}_${toolName}`
 * - Prefixes description with skill ID
 * - Builds a TSC SkillContext per invocation
 * - Catches errors and returns `{ success: false, content }`
 */
export function adaptExternalTool(
  skillId: string,
  toolDef: ExternalToolDef,
  handler: TscToolHandler,
  skillConfig: Record<string, unknown>,
  state: Map<string, unknown>,
  logger: Logger,
  cronDeps?: ExternalToolCronDeps,
  toolExecuteFn?: ToolExecuteFn
): Tool {
  const namespacedName = `${skillId}_${toolDef.name}`;
  const tscLogger = wrapLogger(logger, skillId);

  // Track current invocation args so cron adapter can read _chatId/_botId
  let currentArgs: Record<string, unknown> = {};
  const cronAdapter = buildCronAdapter(tscLogger, cronDeps, () => currentArgs);

  return {
    definition: {
      type: 'function',
      function: {
        name: namespacedName,
        description: `[${skillId}] ${toolDef.description}`,
        parameters: {
          type: 'object',
          properties: toolDef.parameters.properties ?? {},
          required: toolDef.parameters.required,
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      currentArgs = args;
      const noopExecute: ToolExecuteFn = async () => undefined;

      const toolsBridge = Object.freeze({ execute: toolExecuteFn ?? noopExecute });

      const context: TscSkillContext = {
        state,
        config: skillConfig,
        logger: tscLogger,
        data: {
          get: <T = unknown>(key: string) => state.get(key) as T | undefined,
          set: (key: string, value: unknown) => {
            state.set(key, value);
          },
          delete: (key: string) => state.delete(key),
          has: (key: string) => state.has(key),
        },
        cron: cronAdapter,
        tools: toolsBridge,
      };

      try {
        const result = await handler(args, context);
        return {
          success: true,
          content: serializeResult(result),
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ skillId, tool: toolDef.name, err: message }, 'External tool error');
        return {
          success: false,
          content: message,
        };
      }
    },
  };
}

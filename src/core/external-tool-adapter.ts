import type { Logger } from '../logger';
import type { Tool, ToolResult } from '../tools/types';
import type { ExternalToolDef } from './external-skill-loader';

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
}

type TscToolHandler = (args: Record<string, unknown>, context: TscSkillContext) => Promise<unknown>;

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
  logger: Logger
): Tool {
  const namespacedName = `${skillId}_${toolDef.name}`;
  const tscLogger = wrapLogger(logger, skillId);

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
        cron: {
          add: async (opts: Record<string, unknown>) => {
            tscLogger.warn(
              `Cron add called from external tool adapter (job: ${opts.name ?? 'unknown'}) — not supported in this context`
            );
          },
          remove: async (opts: Record<string, unknown>) => {
            tscLogger.warn(
              `Cron remove called from external tool adapter (job: ${opts.jobId ?? 'unknown'}) — not supported in this context`
            );
          },
        },
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

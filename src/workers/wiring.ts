/**
 * Builds the fleet's WorkerPool from the BotContext (called by BotManager when
 * `config.workers.enabled`). Every lookup is live: config, soul dirs, the
 * bot's LLM backend, its tenant.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolRegistry } from '../bot/tool-registry';
import type { BotContext } from '../bot/types';
import { TaskStore } from '../goals/task-store';
import type { KarmaService } from '../karma/service';
import { backupSoulFile } from '../soul';
import { resolveBotPaths } from '../stats/paths';
import { parseGoals } from '../tools/goals';
import { type PoolGoal, WorkerPool, type WorkerPoolDeps } from './pool';
import { WorkerRunStore } from './run-store';
import type { WorkerAnswer, WorkerWait } from './types';
import { createExecutorTurnRunner } from './worker';

export interface FleetWorkerPoolOptions {
  ctx: BotContext;
  toolRegistry: Pick<ToolRegistry, 'getDefinitionsForBot'>;
  karmaService?: KarmaService;
  /** Wake the bot's cycle (BotManager → AgentScheduler.requestImmediateRun, no feedback). */
  wake: (botId: string) => void;
  /** Extra deps (tests, phase 2b `drainAnswers`). */
  overrides?: Partial<WorkerPoolDeps>;
}

/**
 * Answers and decisions for a run that arrived while no pool took them (the
 * stores keep them apart from the cycle's): drained on recover and run start.
 */
export function drainAnswersFrom(
  ctx: Pick<BotContext, 'askHumanStore' | 'askPermissionStore'>
): (runId: string) => WorkerAnswer[] {
  return (runId) => {
    const out: WorkerAnswer[] = [];
    for (const a of ctx.askHumanStore?.consumeAnswersForRun?.(runId) ?? [])
      out.push(
        a.dismissed
          ? { kind: 'ask', id: a.id, dismissed: true }
          : {
              kind: 'ask',
              id: a.id,
              answer: a.answer,
              ...(a.question ? { question: a.question } : {}),
            }
      );
    for (const d of ctx.askPermissionStore?.consumeDecisionsForRun?.(runId) ?? [])
      out.push({ kind: 'approval', id: d.id, decision: d.status });
    return out;
  };
}

/**
 * Close what a run was waiting on when it ends for good (Stop, task moved,
 * goal closed): the question or the permission request leaves the queues
 * without routing anything back to the (ended) run.
 */
export function cancelWaitFrom(
  ctx: Pick<BotContext, 'askHumanStore' | 'askPermissionStore'>
): (wait: WorkerWait) => void {
  return (wait) => {
    if (wait.kind === 'ask') ctx.askHumanStore?.withdrawById?.(wait.id);
    else ctx.askPermissionStore?.withdrawById?.(wait.id, 'withdrawn: the run ended');
  };
}

export function createFleetWorkerPool(opts: FleetWorkerPoolOptions): WorkerPool {
  const { ctx } = opts;
  const logger = ctx.logger;
  const botConfig = (botId: string) => ctx.config.bots.find((b) => b.id === botId);
  const paths = (botId: string) => {
    const b = botConfig(botId);
    return b ? resolveBotPaths(ctx.config, b) : null;
  };
  /** The soul dir when the bot is not loaded (boot recovery runs before bots start). */
  const soulDir = (botId: string): string | null => paths(botId)?.soulDir ?? null;
  const tenantOf = (botId: string): string | undefined => {
    const t = botConfig(botId)?.tenantId;
    return t && ctx.tenantFacade?.isMultiTenant() ? t : undefined;
  };

  const deps: WorkerPoolDeps = {
    config: () => ctx.config.workers,
    store: new WorkerRunStore(ctx.config.paths.data, {
      onError: (err) => logger.warn({ err }, 'Workers: run store warning'),
    }),
    botIds: () => ctx.config.bots.map((b) => b.id),
    taskStore: (botId) => {
      const loader = ctx.soulLoaders.get(botId);
      if (loader) return loader.getTaskStore();
      const dir = soulDir(botId);
      if (!dir) return null;
      return new TaskStore(dir, {
        backup: (p) => backupSoulFile(p, logger),
        onError: (err) => logger.warn({ err, botId }, 'Workers: task store warning'),
      });
    },
    goals: (botId): PoolGoal[] => {
      try {
        const loader = ctx.soulLoaders.get(botId);
        const dir = soulDir(botId);
        const path = dir ? join(dir, 'GOALS.md') : null;
        const md = loader
          ? loader.readGoals()
          : path && existsSync(path)
            ? readFileSync(path, 'utf-8')
            : null;
        return parseGoals(md).active.map((g) => ({
          ...(g.id ? { id: g.id } : {}),
          text: g.text,
          priority: g.priority,
          ...(g.notes ? { notes: g.notes } : {}),
        }));
      } catch {
        return [];
      }
    },
    productionsDir: (botId) => paths(botId)?.workDir ?? join('productions', botId),
    runTurnFor: (botId) =>
      createExecutorTurnRunner({
        ctx,
        botId,
        toolRegistry: opts.toolRegistry,
        karmaService: opts.karmaService,
      }),
    identity: (botId) => {
      const loader = ctx.soulLoaders.get(botId);
      return {
        name: loader?.readIdentityName() ?? botConfig(botId)?.name,
        identity: loader?.readIdentity() ?? undefined,
      };
    },
    botBackend: (botId) => ctx.llmClients.get(botId)?.backend ?? paths(botId)?.backend,
    breaker: ctx.circuitBreaker,
    isBotRunning: (botId) => ctx.runningBots.has(botId),
    quotaOk: (botId) => {
      const tenantId = tenantOf(botId);
      return tenantId ? (ctx.tenantFacade?.checkQuota(tenantId, 'apiCalls') ?? true) : true;
    },
    meter: (botId, info) => {
      const tenantId = tenantOf(botId);
      if (tenantId)
        ctx.tenantFacade?.recordUsage(tenantId, botId, 'llm_request', 1, {
          caller: 'worker',
          ...info,
        });
    },
    activityStream: ctx.activityStream,
    wake: opts.wake,
    drainAnswers: drainAnswersFrom(ctx),
    cancelWait: cancelWaitFrom(ctx),
    logger,
    ...opts.overrides,
  };
  return new WorkerPool(deps);
}

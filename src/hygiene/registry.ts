/**
 * Hygiene registry — routine lookup, runner and run history.
 *
 * `HygieneRegistry.run` builds a `HygieneContext` for a bot (resolving
 * soulDir/workDir exactly like BotManager.startBot does, via
 * resolveAgentConfig / resolveAgentConfigWithTenant), previews, optionally
 * applies, and persists the run to `<dataDir>/hygiene/runs.jsonl`.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  type BotConfig,
  type Config,
  resolveAgentConfig,
  resolveAgentConfigWithTenant,
} from '../config';
import type { Logger } from '../logger';
import { dataCleanup } from './routines/data-cleanup';
import { goalLint } from './routines/goal-lint';
import { memoryHygiene } from './routines/memory-hygiene';
import { productionsTriage } from './routines/productions-triage';
import { soulStructure } from './routines/soul-structure';
import {
  HYGIENE_HISTORY_LIMIT,
  type HygieneApplyResult,
  type HygieneContext,
  type HygieneDeps,
  type HygieneFinding,
  type HygieneRoutine,
  type HygieneRoutineInfo,
  type HygieneRun,
} from './types';

export const ALL_ROUTINE_ID = 'all';

export interface HygieneRegistryDeps {
  config: Config;
  logger: Logger;
  /** Injectable clock (tests). */
  now?: () => Date;
  toolSucceededRecently?: HygieneDeps['toolSucceededRecently'];
  channelStateOf?: HygieneDeps['channelStateOf'];
  lastHealthCheckOf?: HygieneDeps['lastHealthCheckOf'];
}

export interface HygieneRunRequest {
  routine: string;
  botId?: string;
  apply?: boolean;
  options?: Record<string, unknown>;
  /** `all` only: restrict to these bots (default: every configured bot). */
  botIds?: string[];
  /** `all` only: include fleet routines (default true). */
  includeFleet?: boolean;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export class HygieneHistory {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly limit: number = HYGIENE_HISTORY_LIMIT
  ) {
    this.path = join(dataDir, 'hygiene', 'runs.jsonl');
  }

  private readAll(): HygieneRun[] {
    if (!existsSync(this.path)) return [];
    const runs: HygieneRun[] = [];
    for (const line of readFileSync(this.path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        runs.push(JSON.parse(line) as HygieneRun);
      } catch {
        /* skip corrupt line */
      }
    }
    return runs;
  }

  append(run: HygieneRun): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const existing = this.readAll();
      if (existing.length + 1 > this.limit) {
        const kept = [...existing, run].slice(-this.limit);
        writeFileSync(this.path, `${kept.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
      } else {
        appendFileSync(this.path, `${JSON.stringify(run)}\n`, 'utf-8');
      }
    } catch (err) {
      this.logger.warn({ err, path: this.path }, 'Failed to persist hygiene run');
    }
  }

  /** Newest first. */
  list(opts: {
    botId?: string;
    limit?: number;
    filter?: (run: HygieneRun) => boolean;
  }): HygieneRun[] {
    let runs = this.readAll().reverse();
    if (opts.botId) runs = runs.filter((r) => r.botId === opts.botId);
    if (opts.filter) runs = runs.filter(opts.filter);
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
    return runs.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class HygieneRegistry {
  readonly history: HygieneHistory;
  private readonly routines = new Map<string, HygieneRoutine>();
  private readonly now: () => Date;
  private readonly deps: HygieneDeps;

  constructor(private readonly registryDeps: HygieneRegistryDeps) {
    this.now = registryDeps.now ?? (() => new Date());
    this.deps = {
      toolSucceededRecently: registryDeps.toolSucceededRecently ?? (() => false),
      channelStateOf: registryDeps.channelStateOf ?? (() => undefined),
      lastHealthCheckOf: registryDeps.lastHealthCheckOf ?? (() => undefined),
    };
    this.history = new HygieneHistory(this.dataDir, registryDeps.logger);
    for (const r of [goalLint, soulStructure, memoryHygiene, productionsTriage, dataCleanup]) {
      this.register(r);
    }
  }

  private get config(): Config {
    return this.registryDeps.config;
  }

  private get dataDir(): string {
    return resolve(this.config.paths?.data ?? './data');
  }

  register(routine: HygieneRoutine): void {
    this.routines.set(routine.id, routine);
  }

  get(id: string): HygieneRoutine | undefined {
    return this.routines.get(id);
  }

  listRoutines(): HygieneRoutineInfo[] {
    const infos = [...this.routines.values()].map(({ id, name, description, scope, canApply }) => ({
      id,
      name,
      description,
      scope,
      canApply,
    }));
    infos.push({
      id: ALL_ROUTINE_ID,
      name: 'Everything',
      description: 'Runs every bot-scoped routine for every bot, then data-cleanup.',
      scope: 'fleet',
      canApply: true,
    });
    return infos;
  }

  /** Roots every routine is allowed to write under. */
  private baseRoots(): string[] {
    const c = this.config;
    return [
      this.dataDir,
      c.soul?.dir,
      c.productions?.baseDir,
      c.multiTenant?.dataDir,
      c.karma?.baseDir,
    ]
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => resolve(p));
  }

  /** Same resolution BotManager.startBot uses. */
  resolveBotPaths(bot: BotConfig): { soulDir: string; workDir: string } {
    const resolved =
      bot.tenantId && this.config.multiTenant?.enabled
        ? resolveAgentConfigWithTenant(this.config, undefined, bot, bot.tenantId)
        : resolveAgentConfig(this.config, bot);
    return { soulDir: resolve(resolved.soulDir), workDir: resolve(resolved.workDir) };
  }

  buildContext(bot: BotConfig | null, options: Record<string, unknown>): HygieneContext {
    const paths = bot ? this.resolveBotPaths(bot) : null;
    const allowedRoots = this.baseRoots();
    if (paths) allowedRoots.push(paths.soulDir, paths.workDir);
    return {
      botId: bot?.id ?? null,
      soulDir: paths?.soulDir ?? null,
      workDir: paths?.workDir ?? null,
      dataDir: this.dataDir,
      allowedRoots,
      config: this.config,
      logger: this.registryDeps.logger,
      now: this.now(),
      options,
      deps: this.deps,
    };
  }

  async run(req: HygieneRunRequest): Promise<HygieneRun> {
    const startedAt = this.now().toISOString();
    const apply = req.apply === true;
    const options = req.options ?? {};
    const base = (botId: string | null): HygieneRun => ({
      runId: randomUUID(),
      routine: req.routine,
      botId,
      dryRun: !apply,
      startedAt,
      finishedAt: startedAt,
      findings: [],
      applied: [],
      skipped: [],
      backups: [],
    });

    if (req.routine === ALL_ROUTINE_ID) {
      const run = base(null);
      try {
        this.runAll(run, req, apply, options);
      } catch (err) {
        run.error = err instanceof Error ? err.message : String(err);
      }
      run.finishedAt = this.now().toISOString();
      this.history.append(run);
      return run;
    }

    const routine = this.routines.get(req.routine);
    if (!routine) {
      return { ...base(null), error: `Unknown routine: ${req.routine}` };
    }

    let bot: BotConfig | null = null;
    if (routine.scope === 'bot') {
      if (!req.botId) return { ...base(null), error: 'botId is required for bot-scoped routines' };
      bot = this.config.bots.find((b) => b.id === req.botId) ?? null;
      if (!bot) return { ...base(req.botId), error: `Bot not found: ${req.botId}` };
    }

    const run = base(bot?.id ?? null);
    try {
      const ctx = this.buildContext(bot, options);
      run.findings = routine.preview(ctx);
      if (apply) {
        const result = routine.apply(ctx, run.findings);
        run.applied = result.applied;
        run.skipped = result.skipped;
        run.backups = result.backups;
      }
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
      this.registryDeps.logger.error(
        { err, routine: req.routine, botId: req.botId },
        'Hygiene routine failed'
      );
    }
    run.finishedAt = this.now().toISOString();
    this.history.append(run);
    return run;
  }

  private runAll(
    run: HygieneRun,
    req: HygieneRunRequest,
    apply: boolean,
    options: Record<string, unknown>
  ): void {
    const bots = req.botIds
      ? this.config.bots.filter((b) => req.botIds?.includes(b.id))
      : this.config.bots;
    const botRoutines = [...this.routines.values()].filter((r) => r.scope === 'bot');
    const fleetRoutines =
      req.includeFleet === false
        ? []
        : [...this.routines.values()].filter((r) => r.scope === 'fleet');

    const merge = (
      prefix: string,
      botId: string | undefined,
      findings: HygieneFinding[],
      result: HygieneApplyResult | null
    ) => {
      for (const f of findings) run.findings.push({ ...f, id: `${prefix}:${f.id}`, botId });
      if (!result) return;
      run.applied.push(
        ...result.applied.map((a) => ({ ...a, findingId: `${prefix}:${a.findingId}` }))
      );
      run.skipped.push(
        ...result.skipped.map((s) => ({ ...s, findingId: `${prefix}:${s.findingId}` }))
      );
      run.backups.push(...result.backups);
    };

    const execute = (routine: HygieneRoutine, bot: BotConfig | null) => {
      const prefix = bot ? bot.id : 'fleet';
      try {
        const ctx = this.buildContext(bot, options);
        const findings = routine.preview(ctx);
        const result = apply ? routine.apply(ctx, findings) : null;
        merge(prefix, bot?.id, findings, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.registryDeps.logger.error(
          { err, routine: routine.id, botId: bot?.id },
          'Hygiene routine failed'
        );
        run.findings.push({
          id: `${prefix}:${routine.id}:error`,
          kind: 'routine-error',
          severity: 'critical',
          file: null,
          line: null,
          message: `${routine.id} failed: ${message}`,
          fixable: false,
          botId: bot?.id,
        });
      }
    };

    for (const bot of bots) for (const routine of botRoutines) execute(routine, bot);
    for (const routine of fleetRoutines) execute(routine, null);
  }
}

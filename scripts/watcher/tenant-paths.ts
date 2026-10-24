#!/usr/bin/env bun
/**
 * O8 of `docs/plans/watcher-optimizations-plan.md`: assessment only, no
 * migration. `isTenantBot` (src/tenant/tenant-scoping.ts: multi-tenant on and
 * a `tenantId` other than `__admin__`) decides for the watcher since #16; the
 * data-path sites below still branch on *any* `tenantId`, `__admin__`
 * included. For every bot and site this prints what is resolved today and
 * what would be resolved with `isTenantBot`, so the decision to migrate (and
 * whether a one-time move is needed) rests on the real paths.
 *
 *   bun scripts/watcher/tenant-paths.ts [--config config/config.json] [--root .] [--json]
 *
 * Reads the raw config (never Zod-validated, env vars not needed). Writes nothing.
 *
 * Sites: `stats/paths.ts resolveBotPaths` and `hygiene/registry.ts
 * resolveBotPaths` (buildContext) are called for real; `bot-manager.ts`
 * (startBot, resolveSoulDir) and `routes/agents.ts soulDirFor` inline the same
 * expression and are replicated; `routes/chat-history.ts` resolves no path, it
 * gates access (`isBotAccessible`) on the same condition, so its row is the
 * gate.
 */
import { resolve } from 'node:path';
import {
  type BotConfig,
  type Config,
  resolveAgentConfig,
  resolveAgentConfigWithTenant,
} from '../../src/config';
import { HygieneRegistry } from '../../src/hygiene/registry';
import { resolveBotPaths } from '../../src/stats/paths';
import { pickPath } from '../../src/system/effective-config';
import { isTenantBot } from '../../src/tenant/tenant-scoping';
import { cliConfig, fail, parseArgs, resolveCliContext } from '../system-cli';

export type TenantRule = 'today' | 'isTenantBot';

export interface TenantPathRow {
  botId: string;
  tenantId: string | null;
  site: string;
  field: 'soulDir' | 'workDir' | 'tenantGate';
  today: string;
  withIsTenantBot: string;
  differs: boolean;
}

const silent = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => silent,
} as never;

/** Does the site take the tenant branch for this bot under `rule`? */
export function takesTenantBranch(bot: BotConfig, config: Config, rule: TenantRule): boolean {
  return rule === 'today'
    ? !!bot.tenantId && !!config.multiTenant?.enabled
    : isTenantBot(bot, config);
}

/** The inline expression of bot-manager.ts / routes/agents.ts under `rule`. */
export function resolveDirs(
  bot: BotConfig,
  config: Config,
  rule: TenantRule
): { soulDir: string; workDir: string } {
  const r = takesTenantBranch(bot, config, rule)
    ? resolveAgentConfigWithTenant(config, undefined, bot, bot.tenantId as string)
    : resolveAgentConfig(config, bot);
  return { soulDir: resolve(r.soulDir), workDir: resolve(r.workDir) };
}

const safe = (fn: () => string): string => {
  try {
    return fn();
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
};

/** One row per bot × site × field. Pure over the config (reads no disk). */
export function assessTenantPaths(config: Config): TenantPathRow[] {
  const hygiene = new HygieneRegistry({ config, logger: silent });
  const rows: TenantPathRow[] = [];
  for (const bot of config.bots ?? []) {
    const tenantId = bot.tenantId ?? null;
    const push = (site: string, field: TenantPathRow['field'], today: string, next: string) =>
      rows.push({
        botId: bot.id,
        tenantId,
        site,
        field,
        today,
        withIsTenantBot: next,
        differs: today !== next,
      });
    const next = (f: 'soulDir' | 'workDir') =>
      safe(() => resolveDirs(bot, config, 'isTenantBot')[f]);
    for (const f of ['soulDir', 'workDir'] as const) {
      push(
        'stats/paths.ts resolveBotPaths',
        f,
        safe(() => resolve(resolveBotPaths(config, bot)[f])),
        next(f)
      );
      push(
        'hygiene/registry.ts buildContext',
        f,
        safe(() => hygiene.resolveBotPaths(bot)[f]),
        next(f)
      );
      push(
        'bot-manager.ts startBot / resolveSoulDir',
        f,
        safe(() => resolveDirs(bot, config, 'today')[f]),
        next(f)
      );
    }
    push(
      'routes/agents.ts soulDirFor',
      'soulDir',
      safe(() => resolveDirs(bot, config, 'today').soulDir),
      next('soulDir')
    );
    const gate = (rule: TenantRule) =>
      takesTenantBranch(bot, config, rule) ? 'tenant check (isBotAccessible)' : 'no tenant check';
    push('routes/chat-history.ts access gate', 'tenantGate', gate('today'), gate('isTenantBot'));
  }
  return rows;
}

/** The text report: differing rows per bot, then a verdict. */
export function formatAssessment(rows: TenantPathRow[], multiTenant: boolean): string {
  const out: string[] = [];
  out.push(`multiTenant.enabled: ${multiTenant}`);
  const bots = [...new Set(rows.map((r) => r.botId))];
  for (const botId of bots) {
    const mine = rows.filter((r) => r.botId === botId);
    const tenant = mine[0]?.tenantId ?? '—';
    const diff = mine.filter((r) => r.differs);
    out.push('');
    out.push(
      `${botId}  (tenantId: ${tenant})  ${diff.length ? `${diff.length} site(s) differ` : 'same everywhere'}`
    );
    for (const r of mine) {
      const mark = r.differs ? '≠' : '=';
      out.push(`  ${mark} ${r.site} · ${r.field}`);
      out.push(`      today:           ${r.today}`);
      if (r.differs) out.push(`      with isTenantBot: ${r.withIsTenantBot}`);
    }
  }
  const differing = rows.filter((r) => r.differs);
  const pathDiffs = differing.filter((r) => r.field !== 'tenantGate');
  const gateDiffs = differing.filter((r) => r.field === 'tenantGate');
  out.push('');
  out.push(
    `Verdict: ${new Set(pathDiffs.map((r) => r.botId)).size} bot(s) resolve a different path at ${pathDiffs.length} site/field(s); ${new Set(gateDiffs.map((r) => r.botId)).size} bot(s) would lose the chat-history tenant gate.`
  );
  out.push(
    pathDiffs.length
      ? 'Paths differ: switching these sites to isTenantBot needs a one-time move of the data (out of scope for this PR; a plan line instead).'
      : 'No path differs: the sites can switch to isTenantBot without moving data.'
  );
  if (gateDiffs.length) {
    out.push(
      'chat-history: the condition is an access gate, not a path; keep any-tenantId there (isTenantBot would let a tenant caller past the check for an __admin__ bot).'
    );
  }
  return out.join('\n');
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  let context: ReturnType<typeof resolveCliContext>;
  try {
    context = resolveCliContext(args);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const base = cliConfig(context);
  const enabled = pickPath(context.rawConfig, ['multiTenant', 'enabled']) === true;
  const config = {
    ...base,
    multiTenant: { ...(base.multiTenant ?? {}), enabled },
  } as Config;
  const rows = assessTenantPaths(config);
  process.stdout.write(
    `${args.flags.has('json') ? JSON.stringify(rows, null, 2) : formatAssessment(rows, enabled)}\n`
  );
}

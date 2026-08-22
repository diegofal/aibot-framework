/**
 * data-cleanup — fleet-wide orphans under the data directory.
 *
 * Apply never deletes: orphan dirs, legacy config souls and old Claude CLI
 * temp transcripts are moved into `<dataDir>/_trash/<stamp>/…` with a
 * manifest. Config findings (duplicate skills, skills that are really tools)
 * are report-only — bots.json is never rewritten here.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Config } from '../../config';
import { TrashBatch, isWithinRoot } from '../fs-safe';
import { daysBetween } from '../text-utils';
import type { HygieneApplyResult, HygieneContext, HygieneFinding, HygieneRoutine } from '../types';

const TRANSCRIPT_MAX_DAYS = 7;

/**
 * Built-in tool names (mirrors TOOL_CATEGORIES in src/bot/tool-registry.ts —
 * duplicated here so this routine does not import the whole tool tree).
 */
export const KNOWN_TOOL_NAMES = new Set([
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_get',
  'recall_memory',
  'core_memory_append',
  'core_memory_replace',
  'core_memory_search',
  'save_memory',
  'update_soul',
  'update_identity',
  'manage_goals',
  'improve',
  'file_read',
  'file_write',
  'file_edit',
  'exec',
  'process',
  'get_datetime',
  'cron',
  'reddit_search',
  'reddit_hot',
  'reddit_read',
  'twitter_search',
  'twitter_read',
  'twitter_post',
  'calendar_list',
  'calendar_availability',
  'calendar_schedule',
  'ask_human',
  'ask_permission',
  'phone_call',
  'delegate_to_bot',
  'collaborate',
  'moltbook_register',
  'create_agent',
  'send_proactive_message',
  'send_message',
  'mesh_publish',
  'mesh_query',
  'browser',
  'read_production_log',
  'archive_file',
  'create_tool',
  'signal_completion',
]);

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith('.') && name !== '_trash')
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Skill ids that exist as folders under any configured skills path. */
function listSkillFolderIds(config: Config): string[] {
  const paths = config.skillsFolders?.paths ?? [config.paths?.skills].filter(Boolean);
  const ids: string[] = [];
  for (const p of paths as string[]) {
    for (const name of subdirs(resolve(p))) ids.push(name);
  }
  return ids;
}

function karmaDir(config: Config, dataDir: string): string {
  return resolve(config.karma?.baseDir ?? join(dataDir, 'karma'));
}

function tenantsDir(config: Config, dataDir: string): string {
  return resolve(config.multiTenant?.dataDir ?? join(dataDir, 'tenants'));
}

function legacySoulRoot(config: Config): string | null {
  const dir = config.soul?.dir;
  return dir ? resolve(dir) : null;
}

/** Relative path used under _trash: relative to dataDir when inside it, else `<label>/<name>`. */
function trashRel(abs: string, dataDir: string, fallbackLabel: string): string {
  if (isWithinRoot(abs, dataDir)) return relative(resolve(dataDir), abs);
  return join(fallbackLabel, abs.split(/[\\/]/).pop() ?? 'item');
}

function trashFinding(
  kind: string,
  severity: HygieneFinding['severity'],
  abs: string,
  rel: string,
  message: string
): HygieneFinding {
  return {
    id: `data-cleanup:${kind}:${rel.replace(/[\\/]/g, '/')}`,
    kind,
    severity,
    file: rel,
    line: null,
    message,
    fixable: true,
    fix: { action: 'trash', details: `Move to _trash/<stamp>/${rel.replace(/\\/g, '/')}` },
    data: { absPath: abs, relativePath: rel },
  };
}

export const dataCleanup: HygieneRoutine = {
  id: 'data-cleanup',
  name: 'Data cleanup',
  description:
    'Finds orphan karma/soul directories, legacy config/soul copies, old Claude CLI temp transcripts, duplicated skills and skill ids that are really tool names.',
  scope: 'fleet',
  canApply: true,

  preview(ctx: HygieneContext): HygieneFinding[] {
    const findings: HygieneFinding[] = [];
    const { config, dataDir } = ctx;
    const botIds = new Set(config.bots.map((b) => b.id));
    // Real skills, so a name that is both a skill and a tool is not a finding.
    // Tests inject the list; production reads the enabled skills plus the
    // skill folders on disk.
    const knownSkillIds = new Set<string>(
      Array.isArray(ctx.options.knownSkillIds)
        ? (ctx.options.knownSkillIds as string[])
        : [...(config.skills?.enabled ?? []), ...listSkillFolderIds(config)]
    );

    // orphan-karma-dir
    const karma = karmaDir(config, dataDir);
    for (const id of subdirs(karma)) {
      if (botIds.has(id)) continue;
      const abs = join(karma, id);
      findings.push(
        trashFinding(
          'orphan-karma-dir',
          'info',
          abs,
          trashRel(abs, dataDir, 'karma'),
          `Karma data for unknown bot "${id}"`
        )
      );
    }

    // orphan-soul-dir
    const tenants = tenantsDir(config, dataDir);
    for (const tenant of subdirs(tenants)) {
      const botsDir = join(tenants, tenant, 'bots');
      for (const id of subdirs(botsDir)) {
        if (botIds.has(id)) continue;
        const abs = join(botsDir, id);
        findings.push(
          trashFinding(
            'orphan-soul-dir',
            'warn',
            abs,
            trashRel(abs, dataDir, 'tenants'),
            `Bot directory for unknown bot "${id}" under tenant "${tenant}"`
          )
        );
      }
    }

    // legacy-config-soul
    const legacyRoot = legacySoulRoot(config);
    if (legacyRoot && existsSync(legacyRoot)) {
      const explicit = new Set(
        config.bots.map((b) => (b.soulDir ? resolve(b.soulDir) : null)).filter(Boolean)
      );
      for (const id of subdirs(legacyRoot)) {
        const abs = join(legacyRoot, id);
        if (explicit.has(abs)) continue;
        const hasDataSoul = subdirs(tenants).some((t) =>
          existsSync(join(tenants, t, 'bots', id, 'soul'))
        );
        if (!hasDataSoul) continue;
        findings.push(
          trashFinding(
            'legacy-config-soul',
            'info',
            abs,
            trashRel(abs, dataDir, 'config-soul'),
            `Legacy soul copy for "${id}" in ${legacyRoot} — the live soul is under the data dir`
          )
        );
      }
    }

    // claude-tmp-transcripts
    const tmpDir = join(resolve(dataDir), 'claude', 'projects', '-tmp');
    if (existsSync(tmpDir)) {
      for (const name of readdirSync(tmpDir).sort()) {
        if (!name.endsWith('.jsonl')) continue;
        const abs = join(tmpDir, name);
        let age: number;
        try {
          age = daysBetween(statSync(abs).mtime, ctx.now);
        } catch {
          continue;
        }
        if (age <= TRANSCRIPT_MAX_DAYS) continue;
        findings.push(
          trashFinding(
            'claude-tmp-transcripts',
            'info',
            abs,
            trashRel(abs, dataDir, 'claude-tmp'),
            `Claude CLI temp transcript ${name} is ${age} days old`
          )
        );
      }
    }

    // duplicate-skills / skills-are-tools
    for (const bot of config.bots) {
      const skills = bot.skills ?? [];
      const deduped = [...new Set(skills)];
      if (deduped.length !== skills.length) {
        const dupes = [...new Set(skills.filter((s, i) => skills.indexOf(s) !== i))];
        findings.push({
          id: `data-cleanup:duplicate-skills:${bot.id}`,
          kind: 'duplicate-skills',
          severity: 'info',
          file: 'bots.json',
          line: null,
          message: `Bot "${bot.id}" lists ${dupes.join(', ')} more than once`,
          fixable: false,
          data: { botId: bot.id, duplicates: dupes, dedupedSkills: deduped },
        });
      }
      // A few names are legitimately both — `improve` ships as src/skills/improve
      // and as a tool. Only flag a tool name that is not a real skill, otherwise
      // every bot that enables such a skill is reported forever.
      const tools = deduped.filter((s) => KNOWN_TOOL_NAMES.has(s) && !knownSkillIds.has(s));
      if (tools.length > 0) {
        findings.push({
          id: `data-cleanup:skills-are-tools:${bot.id}`,
          kind: 'skills-are-tools',
          severity: 'info',
          file: 'bots.json',
          line: null,
          message: `Bot "${bot.id}" lists tool names as skills: ${tools.join(', ')}`,
          fixable: false,
          data: { botId: bot.id, tools },
        });
      }
    }

    return findings;
  },

  apply(ctx: HygieneContext, findings: HygieneFinding[]): HygieneApplyResult {
    const result: HygieneApplyResult = { applied: [], skipped: [], backups: [] };
    const batch = new TrashBatch(ctx.dataDir, ctx.allowedRoots, ctx.now, ctx.logger);

    for (const f of findings) {
      if (!f.fixable || f.fix?.action !== 'trash') {
        result.skipped.push({ findingId: f.id, reason: 'report only' });
        continue;
      }
      const abs = String(f.data?.absPath ?? '');
      const rel = String(f.data?.relativePath ?? '');
      if (!abs || !rel || !existsSync(abs)) {
        result.skipped.push({ findingId: f.id, reason: 'path missing since preview' });
        continue;
      }
      try {
        const dest = batch.move(abs, rel, f.kind);
        result.applied.push({ findingId: f.id, action: 'trash', result: dest });
      } catch (err) {
        result.skipped.push({
          findingId: f.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    batch.finalize();
    return result;
  },
};
